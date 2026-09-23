import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { recordMovementInTransaction } from "../inventory/stock-movement.service.js";
import { productUnitService } from "../inventory/product-unit.service.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";

export type CreatePurchaseReturnInput = {
  supplierId: string;
  productId: string;
  batchId?: string | null;
  locationId: string;
  reason: "EXPIRED" | "DAMAGED" | "INCORRECT_DELIVERY";
  /** Quantity in the unit identified by `unitId` (or base units when omitted). */
  quantity: number;
  unitId?: string | null;
  unitCost: number;
  debitNoteAmount?: number | null;
  notes?: string | null;
};

export type PurchaseReturnListQuery = PageQuery & {
  supplierId?: string;
  productId?: string;
  reason?: "EXPIRED" | "DAMAGED" | "INCORRECT_DELIVERY";
};

function generateReturnNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `PRN-${timestamp}${random}`;
}

async function assertSupplierActive(supplierId: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true, isActive: true },
  });
  if (!supplier) {
    throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
  }
  if (!supplier.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_SUPPLIER, "Supplier is not active");
  }
}

async function assertProductActive(productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, isActive: true },
  });
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
  if (!product.isActive) {
    throw new AppError(409, ErrorCode.PRODUCT_NOT_FOUND, "Product is not active");
  }
}

async function assertBatchAndStock(
  batchId: string,
  locationId: string,
  quantity: number,
  productId: string,
  supplierId: string,
) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, productId: true, supplierId: true },
  });
  if (!batch) {
    throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
  }
  if (batch.productId !== productId) {
    throw new AppError(422, ErrorCode.BATCH_PRODUCT_MISMATCH, "Batch does not belong to the given product");
  }
  // Supplier ownership: the batch must have been received from the supplier
  // being returned to. Unknown-supplier batches (NULL, e.g. created manually
  // before supplier stamping) cannot be attributed to anyone and are rejected.
  if (batch.supplierId !== supplierId) {
    throw new AppError(
      422,
      ErrorCode.SUPPLIER_BATCH_MISMATCH,
      "The batch was not received from the given supplier",
      { batchSupplierId: batch.supplierId, requestedSupplierId: supplierId },
    );
  }

  const stock = await prisma.inventoryStock.findUnique({
    where: { batchId_locationId: { batchId, locationId } },
    select: { quantity: true },
  });
  if (!stock || stock.quantity.lessThan(quantity)) {
    throw new AppError(
      409,
      ErrorCode.PURCHASE_RETURN_INSUFFICIENT_STOCK,
      "Insufficient stock for this return",
      { available: stock?.quantity.toNumber() ?? 0, requested: quantity }
    );
  }
}

async function assertLocationActive(locationId: string) {
  const location = await prisma.inventoryLocation.findUnique({
    where: { id: locationId },
    select: { id: true, isActive: true },
  });
  if (!location) {
    throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
  }
  if (!location.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_LOCATION, "Location is not active");
  }
}

/**
 * The product must actually have been ordered from this supplier (PO items are
 * the supplier-product relationship in this schema). Returns to a supplier who
 * never supplied the product are rejected.
 */
async function assertSupplierProductRelationship(supplierId: string, productId: string): Promise<void> {
  const count = await prisma.purchaseOrderItem.count({
    where: {
      productId,
      purchaseOrder: { supplierId },
    },
  });
  if (count === 0) {
    throw new AppError(
      422,
      ErrorCode.SUPPLIER_PRODUCT_MISMATCH,
      "This product has never been ordered from the given supplier",
    );
  }
}

export const purchaseReturnService = {
  async list(query: PurchaseReturnListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.PurchaseReturnWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.purchaseReturn.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          product: { select: { id: true, name: true, sku: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          location: { select: { id: true, name: true } },
          unit: { select: { id: true, name: true, symbol: true } },
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.purchaseReturn.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreatePurchaseReturnInput, actor: Pick<AuthenticatedUser, "id">) {
    await assertSupplierActive(input.supplierId);
    await assertProductActive(input.productId);
    await assertLocationActive(input.locationId);

    // The product must actually have been ordered from this supplier.
    await assertSupplierProductRelationship(input.supplierId, input.productId);

    // Quantity is entered in the unit identified by `unitId` (defaults to the
    // product's base unit). Convert to base units up front — stock balances,
    // the movement ledger and the return record all live in base units.
    const entryQuantity = input.quantity;
    let unitFactor: Prisma.Decimal | null = null;
    if (input.unitId) {
      const converted = await productUnitService.toBaseQuantity(
        input.productId,
        input.unitId,
        input.quantity,
      );
      input.quantity = converted.baseQuantity.toNumber();
      unitFactor = converted.unit.conversionFactor;
    }

    // Validate batch and stock if provided
    if (input.batchId) {
      await assertBatchAndStock(input.batchId, input.locationId, input.quantity, input.productId, input.supplierId);
    } else {
      // If no batchId, auto-select a batch owned by this supplier with stock
      // at the location.
      const batchesWithStock = await prisma.inventoryStock.findMany({
        where: {
          productId: input.productId,
          locationId: input.locationId,
          quantity: { gt: 0 },
          batch: { supplierId: input.supplierId },
        },
        select: { batchId: true, quantity: true },
        take: 1,
      });
      if (batchesWithStock.length === 0) {
        throw new AppError(409, ErrorCode.PURCHASE_RETURN_INSUFFICIENT_STOCK, "No stock from this supplier available for this product at the location");
      }
      input.batchId = batchesWithStock[0].batchId;
    }

    // Calculate debit note amount if not provided (from the quantity the user
    // actually entered, in its original unit).
    const debitNoteAmount = input.debitNoteAmount ?? input.unitCost * entryQuantity;

    const returnRecord = await prisma.$transaction(
      async (tx) => {
        // Create the return record first so the stock movement can reference it.
        const created = await tx.purchaseReturn.create({
          data: {
            returnNumber: generateReturnNumber(),
            supplierId: input.supplierId,
            productId: input.productId,
            batchId: input.batchId,
            locationId: input.locationId,
            reason: input.reason,
            quantity: input.quantity,
            unitId: input.unitId ?? null,
            unitConversionFactor: unitFactor,
            unitCost: input.unitCost,
            debitNoteAmount,
            notes: input.notes,
            recordedById: actor.id,
          },
          include: {
            supplier: { select: { id: true, name: true } },
            product: { select: { id: true, name: true, sku: true } },
            batch: { select: { id: true, batchNumber: true, expiryDate: true } },
            location: { select: { id: true, name: true } },
            unit: { select: { id: true, name: true, symbol: true } },
          },
        });

        // Record the movement (RETURN_TO_SUPPLIER OUT) INSIDE this transaction.
        // recordMovementInTransaction re-validates availability under the
        // per-(batch, location) advisory lock, so the availability check above
        // cannot go stale, and the movement + return record commit together.
        // The quantity is always in base units; unitId/conversionFactor are
        // stored as snapshots for the ledger.
        await recordMovementInTransaction(tx, {
          productId: input.productId,
          batchId: input.batchId!,
          locationId: input.locationId,
          transactionType: "RETURN_TO_SUPPLIER",
          direction: "OUT",
          quantity: input.quantity,
          unitId: input.unitId ?? null,
          conversionFactor: unitFactor,
          referenceType: "PurchaseReturn",
          referenceId: created.id,
          notes: `Return to supplier: ${input.reason}`,
          actor,
        });

        // Audit event in the SAME transaction: a rollback of the movement or
        // the return record must also roll this back.
        await recordAuditEvent(
          {
            event: AuditEvent.PURCHASE_RETURN_CREATED,
            entityId: created.id,
            actorId: actor.id,
            metadata: {
              returnNumber: created.returnNumber,
              supplierId: created.supplierId,
              productId: created.productId,
              batchId: created.batchId,
              locationId: created.locationId,
              quantity: created.quantity.toNumber(),
              unitId: created.unitId,
              reason: created.reason,
              debitNoteAmount: created.debitNoteAmount.toNumber(),
            },
          },
          tx,
        );

        return created;
      },
      { timeout: 30_000, maxWait: 15_000 },
    );

    return returnRecord;
  },

  async getById(id: string) {
    const returnRecord = await prisma.purchaseReturn.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, contactPerson: true, email: true, phone: true } },
        product: { select: { id: true, name: true, sku: true } },
        batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        location: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true, symbol: true } },
        recordedBy: { select: { id: true, name: true } },
      },
    });

    if (!returnRecord) {
      throw new AppError(404, ErrorCode.PURCHASE_RETURN_NOT_FOUND, "Purchase return not found");
    }

    return returnRecord;
  },

  async remove(_id: string) {
    // Purchase returns are immutable once created because a RETURN_TO_SUPPLIER
    // stock movement has already been recorded. Deleting the return record
    // without reversing the movement would create an audit inconsistency.
    // Use a cancellation/reversal workflow instead if needed in the future.
    throw new AppError(
      409,
      ErrorCode.PURCHASE_RETURN_IMMUTABLE,
      "Purchase returns cannot be deleted. The associated stock movement has already been recorded. Contact your administrator if a reversal is required."
    );
  },
};