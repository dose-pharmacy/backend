import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { stockMovementService } from "../inventory/stock-movement.service.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreatePurchaseReturnInput = {
  supplierId: string;
  productId: string;
  batchId?: string | null;
  locationId: string;
  reason: "EXPIRED" | "DAMAGED" | "INCORRECT_DELIVERY";
  quantity: number;
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

async function assertBatchAndStock(batchId: string, locationId: string, quantity: number, productId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, productId: true },
  });
  if (!batch) {
    throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
  }
  if (batch.productId !== productId) {
    throw new AppError(422, ErrorCode.BATCH_PRODUCT_MISMATCH, "Batch does not belong to the given product");
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

    // Validate batch and stock if provided
    if (input.batchId) {
      await assertBatchAndStock(input.batchId, input.locationId, input.quantity, input.productId);
    } else {
      // If no batchId, we need at least one batch with stock at the location
      const batchesWithStock = await prisma.inventoryStock.findMany({
        where: { productId: input.productId, locationId: input.locationId, quantity: { gt: 0 } },
        select: { batchId: true, quantity: true },
        take: 1,
      });
      if (batchesWithStock.length === 0) {
        throw new AppError(409, ErrorCode.PURCHASE_RETURN_INSUFFICIENT_STOCK, "No stock available for this product at the location");
      }
      input.batchId = batchesWithStock[0].batchId;
    }

    // Calculate debit note amount if not provided
    const debitNoteAmount = input.debitNoteAmount ?? input.unitCost * input.quantity;

    const returnRecord = await prisma.$transaction(async (tx) => {
      // Record stock movement (RETURN_TO_SUPPLIER OUT)
      await stockMovementService.recordMovement({
        productId: input.productId,
        batchId: input.batchId!,
        locationId: input.locationId,
        transactionType: "RETURN_TO_SUPPLIER",
        direction: "OUT",
        quantity: input.quantity,
        referenceType: "PurchaseReturn",
        referenceId: null, // Will be set after create
        notes: `Return to supplier: ${input.reason}`,
        actor,
      });

      // Create purchase return record
      const created = await tx.purchaseReturn.create({
        data: {
          returnNumber: generateReturnNumber(),
          supplierId: input.supplierId,
          productId: input.productId,
          batchId: input.batchId,
          locationId: input.locationId,
          reason: input.reason,
          quantity: input.quantity,
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
        },
      });

      // Update the stock transaction with referenceId
      await tx.stockTransaction.updateMany({
        where: {
          referenceType: "PurchaseReturn",
          referenceId: null,
          batchId: input.batchId!,
          locationId: input.locationId,
          createdById: actor.id,
        },
        data: { referenceId: created.id },
      });

      return created;
    });

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
        recordedBy: { select: { id: true, name: true } },
      },
    });

    if (!returnRecord) {
      throw new AppError(404, ErrorCode.PURCHASE_RETURN_NOT_FOUND, "Purchase return not found");
    }

    return returnRecord;
  },

  async remove(id: string) {
    const returnRecord = await prisma.purchaseReturn.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!returnRecord) {
      throw new AppError(404, ErrorCode.PURCHASE_RETURN_NOT_FOUND, "Purchase return not found");
    }

    // Note: This does NOT reverse the stock movement - returns are typically not deleted
    // but we allow it with a warning. The stock movement remains for audit trail.
    await prisma.purchaseReturn.delete({ where: { id } });
  },
};