import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { toDecimal } from "../../utils/decimal.js";
import { recordMovementInTransaction } from "../inventory/stock-movement.service.js";
import { productUnitService } from "../inventory/product-unit.service.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";

/**
 * Purchase returns (return goods to a supplier).
 *
 * Financial model (see the FINANCE note in prisma/schema.prisma):
 *  - a return is an INDEPENDENT historical event: it never mutates the original
 *    purchase order, goods receipt, invoice or payment;
 *  - the return VALUE is derived server-side from authoritative purchase data
 *    (the PO item's unit cost x the returned base quantity) - the client cannot
 *    dictate it;
 *  - the value is applied against outstanding supplier payables (invoice
 *    outstandingBalance decremented atomically, never below zero); the portion
 *    that cannot be applied (e.g. the invoice was already fully paid) stays
 *    off `appliedToPayable` and is therefore a supplier refund/credit effect;
 *  - the returned quantity is capped by the PO item's received quantity minus
 *    previous returns, re-validated inside the transaction under an advisory
 *    lock;
 *  - stock leaves through the canonical movement engine (RETURN_TO_SUPPLIER /
 *    OUT) in the SAME transaction, so a return can never exist without its
 *    movement and vice versa.
 */

export type CreatePurchaseReturnInput = {
  supplierId: string;
  productId: string;
  /** The purchase order item whose received goods are being returned. */
  purchaseOrderItemId: string;
  batchId?: string | null;
  locationId: string;
  reason: "EXPIRED" | "DAMAGED" | "INCORRECT_DELIVERY";
  /** Quantity in the unit identified by `unitId` (or base units when omitted). */
  quantity: number;
  unitId?: string | null;
  /** Optional cost override; defaults to the PO item's authoritative unitCost. */
  unitCost?: number;
  debitNoteAmount?: number | null;
  notes?: string | null;
  /** De-duplication key; a retry with the same key returns the original return. */
  idempotencyKey?: string | null;
};

export type PurchaseReturnListQuery = PageQuery & {
  supplierId?: string;
  productId?: string;
  reason?: "EXPIRED" | "DAMAGED" | "INCORRECT_DELIVERY";
};

const PO_ITEM_DETAIL_SELECT = {
  id: true,
  unitCost: true,
  quantityReceived: true,
  purchaseOrder: { select: { id: true, poNumber: true } },
} satisfies Prisma.PurchaseOrderItemSelect;

function generateReturnNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return "PRN-" + timestamp + random;
}

function money(value: Prisma.Decimal | number | string): Prisma.Decimal {
  const decimal = value instanceof Prisma.Decimal ? value : toDecimal(value);
  return decimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Derived invoice payment status (mirrors supplier-invoice.service). */
function statusForOutstanding(outstanding: Prisma.Decimal, totalAmount: Prisma.Decimal) {
  if (outstanding.lte(0)) return "PAID" as const;
  if (outstanding.lt(totalAmount)) return "PARTIALLY_PAID" as const;
  return "OPEN" as const;
}

/** Serialises concurrent writers for one logical resource (tx-scoped lock). */
async function lockAdvisory(tx: Prisma.TransactionClient, key: string): Promise<void> {
  // $executeRaw because pg_advisory_xact_lock returns void.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
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
 * Validates the (batch, location, quantity) triple:
 *  - the batch belongs to the product being returned;
 *  - the batch was received from the supplier being returned to;
 *  - the location holds at least `quantity` of the batch (advisory check -
 *    the movement engine re-validates under the per-(batch, location) lock).
 */
async function assertBatchAndStock(
  batchId: string,
  locationId: string,
  quantity: Prisma.Decimal,
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
      { available: stock?.quantity.toNumber() ?? 0, requested: quantity.toNumber() }
    );
  }
}

/**
 * The authoritative per-item state for a return, computed from confirmed
 * receiving data:
 *  - the PO item must belong to a PO of the given supplier (the supplier-
 *    product relationship in this schema);
 *  - the PO must not be CANCELLED (cancelled orders have no returnable goods);
 *  - `returnable` = quantityReceived MINUS all previous returns of this PO
 *    item (re-read inside the caller's transaction so the cap cannot be raced).
 */
export async function getReturnableState(
  purchaseOrderItemId: string,
  supplierId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const poItem = await client.purchaseOrderItem.findUnique({
    where: { id: purchaseOrderItemId },
    select: {
      id: true,
      productId: true,
      unitId: true,
      unit: { select: { id: true, name: true, symbol: true } },
      quantityOrderedBase: true,
      quantityOrdered: true,
      quantityReceived: true,
      unitCost: true,
      purchaseOrder: {
        select: { id: true, supplierId: true, poNumber: true, status: true },
      },
    },
  });
  if (!poItem) {
    throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order item not found");
  }
  if (poItem.purchaseOrder.supplierId !== supplierId) {
    throw new AppError(
      422,
      ErrorCode.SUPPLIER_PRODUCT_MISMATCH,
      "The purchase order item belongs to a different supplier",
    );
  }
  if (poItem.purchaseOrder.status === "CANCELLED") {
    throw new AppError(
      422,
      ErrorCode.BAD_REQUEST,
      "Goods from a cancelled purchase order cannot be returned",
    );
  }

  // Previous returns of this PO item, in base units. Rows without a PO-item
  // link are legacy rows that predate the linkage; they cannot be attributed
  // to an item, so the physical stock cap still bounds them.
  const previouslyReturned = await client.purchaseReturn.aggregate({
    where: { purchaseOrderItemId },
    _sum: { quantity: true },
  });

  const returned = previouslyReturned._sum.quantity ?? new Prisma.Decimal(0);
  const returnable = poItem.quantityReceived.minus(returned);

  return { poItem, previouslyReturned: returned, returnable };
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
          purchaseOrderItem: { select: PO_ITEM_DETAIL_SELECT },
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

    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await prisma.purchaseReturn.findUnique({ where: { idempotencyKey } });
      if (existing) {
        // Replay of an already-confirmed submission: return the original
        // record instead of creating a second one (no double stock/finance).
        return existing;
      }
    }

    if (input.quantity <= 0) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Return quantity must be greater than zero");
    }

    // Quantity is entered in the unit identified by `unitId` (defaults to the
    // product's base unit). Convert to base units up front - stock balances,
    // the movement ledger and the return record all live in base units.
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

    const returnRecord = await prisma.$transaction(
      async (tx) => {
        // Serialization point for the whole financial transaction: concurrent
        // returns of the same PO item (and replays of the same idempotency
        // key) queue up here, so every check below runs against settled state.
        if (idempotencyKey) {
          await lockAdvisory(tx, "purchaseReturnIdempotency:" + idempotencyKey);
        }
        await lockAdvisory(tx, "purchaseReturnPoItem:" + input.purchaseOrderItemId);

        // Idempotent replay: re-check INSIDE the lock - two concurrent requests
        // with the same key must not both pass the pre-transaction check.
        if (idempotencyKey) {
          const existing = await tx.purchaseReturn.findUnique({ where: { idempotencyKey } });
          if (existing) {
            return existing;
          }
        }

        // Re-read the authoritative state INSIDE the transaction.
        const { poItem, returnable } = await getReturnableState(
          input.purchaseOrderItemId,
          input.supplierId,
          tx,
        );

        if (poItem.productId !== input.productId) {
          throw new AppError(
            422,
            ErrorCode.BATCH_PRODUCT_MISMATCH,
            "The purchase order item belongs to a different product",
          );
        }

        const baseQuantity = toDecimal(input.quantity);
        if (baseQuantity.lte(0)) {
          throw new AppError(422, ErrorCode.BAD_REQUEST, "Return quantity must be greater than zero");
        }
        if (baseQuantity.gt(returnable)) {
          throw new AppError(
            422,
            ErrorCode.PURCHASE_RETURN_EXCEEDS_RETURNABLE,
            "Return quantity exceeds the remaining returnable quantity for this purchase order item",
            {
              purchaseOrderItemId: poItem.id,
              quantityReceived: poItem.quantityReceived.toNumber(),
              returnable: returnable.toNumber(),
              requested: baseQuantity.toNumber(),
            },
          );
        }

        // Resolve the batch to return from (explicit, or auto-select a batch
        // owned by this supplier with enough stock at the location).
        let batchId = input.batchId ?? null;
        if (batchId) {
          await assertBatchAndStock(batchId, input.locationId, baseQuantity, input.productId, input.supplierId);
        } else {
          const batchesWithStock = await tx.inventoryStock.findMany({
            where: {
              productId: input.productId,
              locationId: input.locationId,
              quantity: { gte: baseQuantity },
              batch: { supplierId: input.supplierId },
            },
            select: { batchId: true },
            take: 1,
          });
          if (batchesWithStock.length === 0) {
            throw new AppError(
              409,
              ErrorCode.PURCHASE_RETURN_INSUFFICIENT_STOCK,
              "No stock from this supplier available for this product at the location",
            );
          }
          batchId = batchesWithStock[0].batchId;
        }

        // ---------------------------------------------------------------
        // Return value: derived from authoritative purchase data, never
        // trusted from the client. unitCost is per PO-item (ordered) unit;
        // quantityReceived and the returned quantity are in base units, so
        // the per-BASE-unit cost is unitCost x quantityOrdered /
        // quantityOrderedBase (the same conversion the stock movement engine
        // uses). Legacy items without a base snapshot are treated as base.
        // ---------------------------------------------------------------
        const unitFactorSnapshot =
          poItem.quantityOrdered.gt(0) && poItem.quantityOrderedBase.gt(0)
            ? poItem.quantityOrderedBase.div(poItem.quantityOrdered)
            : new Prisma.Decimal(1);
        const unitCostPerBaseUnit = poItem.unitCost.div(unitFactorSnapshot);
        const returnValue = money(unitCostPerBaseUnit.mul(baseQuantity));

        // Client-supplied cost/amount values are only accepted when they match
        // the derived value (keeps old clients working, blocks tampering).
        if (input.unitCost !== undefined) {
          const suppliedReturnValue = money(toDecimal(input.unitCost).mul(baseQuantity));
          if (!suppliedReturnValue.eq(returnValue)) {
            throw new AppError(
              422,
              ErrorCode.PURCHASE_RETURN_VALUE_MISMATCH,
              "The supplied unit cost does not match the purchase order item cost",
              { expectedReturnValue: returnValue.toNumber(), suppliedReturnValue: suppliedReturnValue.toNumber() },
            );
          }
        }
        if (input.debitNoteAmount !== undefined && input.debitNoteAmount !== null) {
          const supplied = money(input.debitNoteAmount);
          if (!supplied.eq(returnValue)) {
            throw new AppError(
              422,
              ErrorCode.PURCHASE_RETURN_VALUE_MISMATCH,
              "The supplied debit note amount does not match the derived return value",
              { expectedReturnValue: returnValue.toNumber(), supplied: supplied.toNumber() },
            );
          }
        }

        // ---------------------------------------------------------------
        // Apply the return value against outstanding payables of THIS PO.
        // The PO's invoices are consumed oldest-first; each application is a
        // conditional decrement (WHERE outstandingBalance >= amount) so a
        // concurrent payment/return can never push an outstanding balance
        // negative - the loser matches zero rows. The portion that cannot be
        // applied (nothing outstanding, e.g. fully paid invoices) stays off
        // `appliedToPayable` and is Finance's supplier refund/credit effect.
        // ---------------------------------------------------------------
        let remaining = returnValue;
        const openInvoices = await tx.supplierInvoice.findMany({
          where: { purchaseOrderId: poItem.purchaseOrder.id, outstandingBalance: { gt: 0 } },
          select: { id: true },
          orderBy: { invoiceDate: "asc" },
        });
        const touchedInvoiceIds: string[] = [];
        for (const invoice of openInvoices) {
          if (remaining.lte(0)) break;
          const balance = await tx.supplierInvoice.findUnique({
            where: { id: invoice.id },
            select: { outstandingBalance: true },
          });
          if (!balance || balance.outstandingBalance.lte(0)) {
            continue;
          }
          const amount = remaining.lt(balance.outstandingBalance) ? remaining : balance.outstandingBalance;
          const updated = await tx.supplierInvoice.updateMany({
            where: { id: invoice.id, outstandingBalance: { gte: amount } },
            data: { outstandingBalance: { decrement: amount } },
          });
          if (updated.count === 0) {
            // Another writer consumed this balance - move to the next invoice.
            continue;
          }
          touchedInvoiceIds.push(invoice.id);
          remaining = remaining.minus(amount);
        }
        // Restore the derived payment status of every touched invoice.
        for (const invoiceId of touchedInvoiceIds) {
          const invoice = await tx.supplierInvoice.findUnique({
            where: { id: invoiceId },
            select: { outstandingBalance: true, totalAmount: true },
          });
          if (invoice) {
            await tx.supplierInvoice.update({
              where: { id: invoiceId },
              data: { status: statusForOutstanding(invoice.outstandingBalance, invoice.totalAmount) },
            });
          }
        }
        const appliedToPayable = returnValue.minus(remaining);

        // Create the return record FIRST so the movement can reference it.
        const created = await tx.purchaseReturn.create({
          data: {
            returnNumber: generateReturnNumber(),
            supplierId: input.supplierId,
            productId: input.productId,
            purchaseOrderItemId: poItem.id,
            batchId,
            locationId: input.locationId,
            reason: input.reason,
            quantity: input.quantity,
            unitId: input.unitId ?? null,
            unitConversionFactor: unitFactor,
            unitCost: unitCostPerBaseUnit,
            debitNoteAmount: returnValue,
            appliedToPayable,
            idempotencyKey,
            notes: input.notes,
            recordedById: actor.id,
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
          batchId: batchId!,
          locationId: input.locationId,
          transactionType: "RETURN_TO_SUPPLIER",
          direction: "OUT",
          quantity: input.quantity,
          unitId: input.unitId ?? null,
          conversionFactor: unitFactor,
          referenceType: "PurchaseReturn",
          referenceId: created.id,
          notes: "Return to supplier: " + input.reason,
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
              purchaseOrderItemId: created.purchaseOrderItemId,
              batchId: created.batchId,
              locationId: created.locationId,
              quantity: created.quantity.toNumber(),
              unitId: created.unitId,
              reason: created.reason,
              returnValue: returnValue.toNumber(),
              appliedToPayable: appliedToPayable.toNumber(),
              supplierRefundCredit: remaining.toNumber(),
            },
          },
          tx,
        );

        return tx.purchaseReturn.findUnique({
          where: { id: created.id },
          include: {
            supplier: { select: { id: true, name: true } },
            product: { select: { id: true, name: true, sku: true } },
            batch: { select: { id: true, batchNumber: true, expiryDate: true } },
            location: { select: { id: true, name: true } },
            unit: { select: { id: true, name: true, symbol: true } },
            purchaseOrderItem: { select: PO_ITEM_DETAIL_SELECT },
          },
        });
      },
      { timeout: 30_000, maxWait: 15_000 },
    );

    return returnRecord;
  },

  /** Remaining returnable quantity per PO item (base units) for the UI. */
  async returnableQuantity(purchaseOrderItemId: string, supplierId: string) {
    const { poItem, previouslyReturned, returnable } = await getReturnableState(
      purchaseOrderItemId,
      supplierId,
    );
    return {
      purchaseOrderItemId,
      poNumber: poItem.purchaseOrder.poNumber,
      productId: poItem.productId,
      quantityReceived: poItem.quantityReceived,
      previouslyReturned,
      returnable,
      unitCost: poItem.unitCost,
      unit: poItem.unit,
    };
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
        purchaseOrderItem: { select: PO_ITEM_DETAIL_SELECT },
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
