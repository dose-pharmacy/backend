import { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { recordMovementInTransaction } from "../inventory/stock-movement.service.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";
import { addUtcDays, startOfTodayUtc, toUtcDay } from "../../utils/date-time.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import type { DbClient } from "./requirement.service.js";
import { recomputeRequirementStatus } from "./requirement.service.js";
import {
  calculatePurchaseOrderStatus,
  remainingQuantityFor,
} from "./purchase-order.service.js";

export type CreateGRInput = {
  purchaseOrderId: string;
  receivedDate?: Date;
  discrepancyNote?: string | null;
  items: Array<{
    purchaseOrderItemId: string;
    locationId: string;
    deliveredQty: number;
    actualQty: number;
    // Expected quantity for THIS receipt line. The manual web form omits it and
    // the PO item's current remaining quantity is used. The invoice-assisted
    // flow sets it to the supplier's document quantity for the line so a
    // document/physical mismatch is reflected in the receipt status without
    // misreading a multi-batch delivery as a shortage.
    expectedQty?: number;
    batchNumber?: string | null;
    manufacturingDate?: Date | null;
    expiryDate?: Date | null;
  }>;
};

export type UpdateGRItemInput = {
  id: string;
  deliveredQty?: number;
  actualQty?: number;
  batchNumber?: string | null;
  manufacturingDate?: Date | null;
  expiryDate?: Date | null;
};

export type ResolveGRInput = {
  discrepancyNote?: string | null;
  items?: UpdateGRItemInput[];
};

export type GRListQuery = PageQuery & {
  purchaseOrderId?: string;
  status?: "MATCHED" | "DISCREPANCY" | "RESOLVED";
};

function generateReceiptNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `GR-${timestamp}${random}`;
}

const MIN_EXPIRY_DATE = addUtcDays(startOfTodayUtc(), 1);

function assertExpiryValid(expiry: Date): void {
  if (toUtcDay(expiry).getTime() < MIN_EXPIRY_DATE.getTime()) {
    throw new AppError(
      422,
      ErrorCode.INVALID_EXPIRY_DATE,
      "Expiry date must be at least tomorrow"
    );
  }
}

async function assertPOExistsAndValid(poId: string, db: DbClient = prisma) {
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    select: { id: true, status: true, supplierId: true },
  });
  if (!po) {
    throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
  }
  if (po.status === "CANCELLED" || po.status === "CLOSED") {
    throw new AppError(409, ErrorCode.PO_STATUS_TRANSITION_INVALID, "Cannot create receipt for cancelled or closed order");
  }
  return po;
}

async function assertLocationActive(locationId: string, db: DbClient = prisma) {
  const location = await db.inventoryLocation.findUnique({
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

async function assertPOItemBelongsToPO(poItemId: string, poId: string, db: DbClient = prisma) {
  const item = await db.purchaseOrderItem.findUnique({
    where: { id: poItemId },
    select: { id: true, purchaseOrderId: true, productId: true, quantityOrdered: true, quantityOrderedBase: true, quantityReceived: true, quantityShort: true, unitId: true, unit: { select: { id: true, name: true, symbol: true } }, unitCost: true },
  });
  if (!item) {
    throw new AppError(404, ErrorCode.PURCHASE_ORDER_ITEM_NOT_FOUND, "Purchase order item not found");
  }
  if (item.purchaseOrderId !== poId) {
    throw new AppError(422, ErrorCode.BAD_REQUEST, "Purchase order item does not belong to the specified purchase order");
  }
  return item;
}

function computeGRStatus(
  items: Array<{ expectedQty: number; deliveredQty: number; actualQty: number }>
): "MATCHED" | "DISCREPANCY" {
  for (const item of items) {
    if (item.actualQty !== item.deliveredQty || item.deliveredQty !== item.expectedQty) {
      return "DISCREPANCY";
    }
  }
  return "MATCHED";
}

export const goodsReceiptService = {
  async list(query: GRListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.GoodsReceiptWhereInput = {
      ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total, statusGroups] = await prisma.$transaction([
      prisma.goodsReceipt.findMany({
        where,
        include: {
          purchaseOrder: { select: { id: true, poNumber: true, supplierId: true } },
          createdBy: { select: { id: true, name: true } },
          confirmedBy: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.goodsReceipt.count({ where }),
      // Summary counts over the FILTERED dataset (not just the page).
      prisma.goodsReceipt.groupBy({
        by: ["status"],
        where,
        orderBy: [],
        _count: true,
      }),
    ]);

    const countByStatus = new Map(statusGroups.map((g) => [g.status, g._count]));
    const summary = {
      matched: countByStatus.get("MATCHED") ?? 0,
      discrepancy: countByStatus.get("DISCREPANCY") ?? 0,
      resolved: countByStatus.get("RESOLVED") ?? 0,
    };

    return { items, meta: buildPaginationMeta(total, page, limit), summary };
  },

  async create(
    input: CreateGRInput,
    actor: Pick<AuthenticatedUser, "id">,
    externalTx?: Prisma.TransactionClient,
  ) {
    // Composable with the invoice-assisted receiving flow: when an external
    // transaction is supplied every read/write uses it, so the receipt is
    // created atomically with the rest of the receiving operation. The manual
    // web form calls this without a tx and keeps its previous behaviour.
    const db = externalTx ?? prisma;
    const po = await assertPOExistsAndValid(input.purchaseOrderId, db);

    // A receipt represents an actual delivery: it must contain at least one
    // line. (The HTTP layer already enforces the non-empty array; this keeps
    // direct service callers honest too.)
    if (input.items.length === 0) {
      throw new AppError(
        422,
        ErrorCode.VALIDATION_ERROR,
        "A goods receipt must contain at least one item",
      );
    }

    // Validate each item
    const validatedItems = [];
    // Aggregate the accepted quantity per PO item so several lines (multi-batch
    // deliveries) for the same item can never together exceed its remaining
    // quantity.
    const acceptedByItem = new Map<
      string,
      { remaining: number; accepted: number; poItemId: string }
    >();
    for (const item of input.items) {
      // Check PO item belongs to PO
      const poItem = await assertPOItemBelongsToPO(item.purchaseOrderItemId, input.purchaseOrderId, db);

      // Check location
      await assertLocationActive(item.locationId, db);

      // Remaining quantity on the PO item. Accepted shortages reduce the
      // outstanding expectation: they are already reconciled against the order.
      // This is the hard cap for what may be received on the item.
      const remainingQty = remainingQuantityFor(poItem);

      // Validate quantities. A GR item may represent a fully short delivery
      // (actualQty = 0, deliveredQty = 0) so both quantities are >= 0.
      if (item.deliveredQty < 0 || item.actualQty < 0) {
        throw new AppError(
          422,
          ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
          "Quantities must be greater than or equal to zero",
        );
      }
      if (item.actualQty <= 0 && item.deliveredQty > 0) {
        throw new AppError(
          422,
          ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
          "Actual quantity must be greater than zero when a delivery is recorded",
        );
      }

      // Never receive more than the remaining quantity on the PO item.
      if (item.actualQty > remainingQty) {
        throw new AppError(
          422,
          ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
          "Actual quantity exceeds the remaining quantity on the purchase order item",
          { remainingQuantity: remainingQty, requestedQuantity: item.actualQty },
        );
      }

      // If actualQty > 0, batchNumber and expiryDate are required
      if (item.actualQty > 0) {
        if (!item.batchNumber) {
          throw new AppError(422, ErrorCode.GOODS_RECEIPT_BATCH_REQUIRED, "Batch number is required when actual quantity > 0");
        }
        if (!item.expiryDate) {
          throw new AppError(422, ErrorCode.GOODS_RECEIPT_EXPIRY_REQUIRED, "Expiry date is required when actual quantity > 0");
        }
        assertExpiryValid(item.expiryDate);
      }

      const agg = acceptedByItem.get(poItem.id) ?? {
        remaining: remainingQty,
        accepted: 0,
        poItemId: poItem.id,
      };
      agg.accepted += item.actualQty;
      acceptedByItem.set(poItem.id, agg);

      validatedItems.push({
        ...item,
        // The expected/documented quantity for this line. Defaults to the PO
        // item's remaining quantity (manual web form); the invoice-assisted
        // flow passes the supplier document quantity so a document/physical
        // mismatch surfaces as a receipt discrepancy.
        expectedQty: item.expectedQty ?? remainingQty,
        poItem,
      });
    }

    // Cross-line cap: the sum of all lines (batches) for one PO item must never
    // exceed that item's remaining quantity.
    for (const agg of acceptedByItem.values()) {
      if (agg.accepted > agg.remaining) {
        throw new AppError(
          422,
          ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
          "Actual quantity exceeds the remaining quantity on the purchase order item",
          {
            purchaseOrderItemId: agg.poItemId,
            remainingQuantity: agg.remaining,
            requestedQuantity: agg.accepted,
          },
        );
      }
    }

    // At least one line must actually receive stock; an all-zero receipt is not
    // a delivery.
    if (!validatedItems.some((item) => item.actualQty > 0)) {
      throw new AppError(
        422,
        ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
        "A goods receipt must receive at least one item with a quantity greater than zero",
      );
    }

    // Compute status
    const status = computeGRStatus(
      validatedItems.map((i) => ({ expectedQty: i.expectedQty, deliveredQty: i.deliveredQty, actualQty: i.actualQty }))
    );

    const receipt = await db.goodsReceipt.create({
      data: {
        receiptNumber: generateReceiptNumber(),
        purchaseOrderId: input.purchaseOrderId,
        supplierId: po.supplierId,
        receivedDate: input.receivedDate ? toUtcDay(input.receivedDate) : new Date(),
        status,
        discrepancyNote: input.discrepancyNote,
        createdById: actor.id,
        items: {
          create: validatedItems.map((item) => ({
            purchaseOrderItemId: item.purchaseOrderItemId,
            locationId: item.locationId,
            expectedQty: item.expectedQty,
            deliveredQty: item.deliveredQty,
            actualQty: item.actualQty,
            // Quantities are in the PO item's ordered unit, snapshotted so a
            // later unit reconfiguration never reinterprets history.
            unitId: item.poItem.unitId,
            unitCost: item.poItem.unitCost.toNumber(),
            batchNumber: item.batchNumber,
            manufacturingDate: item.manufacturingDate ? toUtcDay(item.manufacturingDate) : null,
            expiryDate: item.expiryDate ? toUtcDay(item.expiryDate) : null,
          })),
        },
      },
      include: {
        purchaseOrder: { select: { id: true, poNumber: true } },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            purchaseOrderItem: { select: { id: true, productId: true, unitCost: true } },
            location: { select: { id: true, name: true } },
            unit: { select: { id: true, name: true, symbol: true } },
          },
        },
      },
    });

    await recordAuditEvent(
      {
        event: AuditEvent.GOODS_RECEIPT_CREATED,
        entityId: receipt.id,
        actorId: actor.id,
        metadata: {
          receiptNumber: receipt.receiptNumber,
          purchaseOrderId: input.purchaseOrderId,
          supplierId: po.supplierId,
          status,
          itemCount: validatedItems.length,
        },
      },
      db,
    );

    return receipt;
  },

  async getById(id: string) {
    const receipt = await prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        purchaseOrder: {
          select: { id: true, poNumber: true, supplierId: true, supplier: { select: { id: true, name: true } } },
        },
        createdBy: { select: { id: true, name: true } },
        confirmedBy: { select: { id: true, name: true } },
        items: {
          include: {
            purchaseOrderItem: {
              select: {
                id: true,
                productId: true,
                product: { select: { id: true, name: true, sku: true } },
                unitCost: true,
                quantityOrdered: true,
                quantityReceived: true,
              },
            },
            location: { select: { id: true, name: true } },
            unit: { select: { id: true, name: true, symbol: true } },
            batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          },
        },
      },
    });

    if (!receipt) {
      throw new AppError(404, ErrorCode.GOODS_RECEIPT_NOT_FOUND, "Goods receipt not found");
    }

    return receipt;
  },

  async resolve(id: string, input: ResolveGRInput, actor?: Pick<AuthenticatedUser, "id">) {
    const receipt = await prisma.goodsReceipt.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!receipt) {
      throw new AppError(404, ErrorCode.GOODS_RECEIPT_NOT_FOUND, "Goods receipt not found");
    }
    if (receipt.status === "MATCHED") {
      throw new AppError(409, ErrorCode.BAD_REQUEST, "Receipt is already matched, no resolution needed");
    }

    // Update items if provided
    if (input.items && input.items.length > 0) {
      for (const item of input.items) {
        const grItem = await prisma.goodsReceiptItem.findUnique({
          where: { id: item.id },
          select: { id: true, goodsReceiptId: true },
        });
        if (!grItem || grItem.goodsReceiptId !== id) {
          throw new AppError(404, ErrorCode.GOODS_RECEIPT_ITEM_NOT_FOUND, `Goods receipt item ${item.id} not found`);
        }
      }

      await prisma.$transaction(
        input.items.map((item) =>
          prisma.goodsReceiptItem.update({
            where: { id: item.id },
            data: {
              deliveredQty: item.deliveredQty,
              actualQty: item.actualQty,
              batchNumber: item.batchNumber,
              manufacturingDate: item.manufacturingDate ? toUtcDay(item.manufacturingDate) : null,
              expiryDate: item.expiryDate ? toUtcDay(item.expiryDate) : null,
            },
          })
        )
      );
    }

    // Recompute status
    const items = await prisma.goodsReceiptItem.findMany({
      where: { goodsReceiptId: id },
      select: { expectedQty: true, deliveredQty: true, actualQty: true },
    });

    let newStatus: "MATCHED" | "DISCREPANCY" | "RESOLVED";
    const allMatch = items.every(
      (i) => i.actualQty === i.deliveredQty && i.deliveredQty === i.expectedQty
    );

    if (allMatch) {
      newStatus = "MATCHED";
    } else if (input.discrepancyNote && input.discrepancyNote.trim().length > 0) {
      newStatus = "RESOLVED";
    } else {
      newStatus = "DISCREPANCY";
    }

    const updated = await prisma.goodsReceipt.update({
      where: { id },
      data: {
        status: newStatus,
        discrepancyNote: input.discrepancyNote ?? undefined,
      },
    });

    await recordAuditEvent({
      event: AuditEvent.GOODS_RECEIPT_RESOLVED,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: { receiptNumber: updated.receiptNumber, newStatus },
    });

    return updated;
  },

  /**
   * Confirms a goods receipt.
   *
   * - Fully transactional: batches, stock movements, PO item cumulative
   *   quantities, requirement fulfillment and PO status all commit together or
   *   not at all.
   * - Idempotent: the confirmation flag is flipped with a guarded update
   *   (WHERE confirmedById IS NULL) as the FIRST write; a second concurrent
   *   confirm loses that race and aborts without any other effect.
   * - Multiple receipts per PO item accumulate safely (increment, never
   *   overwrite).
   * - Accepted shortages never increase stock and never double-count against
   *   requirements.
   */
  async confirm(
    id: string,
    actor: Pick<AuthenticatedUser, "id">,
    externalTx?: Prisma.TransactionClient,
  ) {
    // `run` is the canonical confirmation body. Supplying `externalTx` lets the
    // invoice-assisted receiving flow compose create + confirm + invoice in one
    // atomic transaction without duplicating any of this logic.
    const run = async (tx: Prisma.TransactionClient) => {
        const receipt = await tx.goodsReceipt.findUnique({
          where: { id },
          include: {
            purchaseOrder: {
              select: { id: true, poNumber: true, status: true, supplierId: true },
            },
            items: {
              include: {
                purchaseOrderItem: {
                  select: {
                    id: true,
                    productId: true,
                    requirementLineId: true,
                    quantityOrdered: true,
                    quantityOrderedBase: true,
                  },
                },
                location: { select: { id: true } },
              },
            },
          },
        });

        if (!receipt) {
          throw new AppError(404, ErrorCode.GOODS_RECEIPT_NOT_FOUND, "Goods receipt not found");
        }
        if (receipt.status !== "MATCHED" && receipt.status !== "RESOLVED") {
          throw new AppError(409, ErrorCode.GOODS_RECEIPT_CANNOT_CONFIRM, "Receipt must be matched or resolved before confirmation");
        }
        if (receipt.confirmedById) {
          throw new AppError(409, ErrorCode.GOODS_RECEIPT_ALREADY_CONFIRMED, "Receipt has already been confirmed");
        }
        const poStatus = receipt.purchaseOrder.status;
        if (poStatus === PurchaseOrderStatus.CANCELLED || poStatus === PurchaseOrderStatus.CLOSED) {
          throw new AppError(
            409,
            ErrorCode.PO_STATUS_TRANSITION_INVALID,
            "Cannot confirm a receipt for a cancelled or closed order",
          );
        }

        // Concurrency guard: atomically claim the confirmation. If another
        // request confirmed first, this update matches zero rows and we abort
        // before touching stock or quantities.
        const claimed = await tx.goodsReceipt.updateMany({
          where: { id, confirmedById: null },
          data: { confirmedById: actor.id },
        });
        if (claimed.count === 0) {
          throw new AppError(409, ErrorCode.GOODS_RECEIPT_ALREADY_CONFIRMED, "Receipt has already been confirmed");
        }

        const supplierId = receipt.purchaseOrder.supplierId;

        // Lock every PO item this receipt touches (sorted to avoid deadlocks) so
        // two receipts — or a receipt and a shortage accept — cannot both
        // consume the same remaining quantity.
        const poItemIds = [...new Set(receipt.items.map((i) => i.purchaseOrderItemId))].sort();
        if (poItemIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM "purchase_order_item" WHERE id IN (${Prisma.join(poItemIds)}) ORDER BY id FOR UPDATE`;
        }

        // Re-validate against the CURRENT (now locked) remaining quantity. The
        // create step validated a snapshot; another receipt may have been
        // confirmed in between, so the database is the authority here.
        const currentItems = poItemIds.length
          ? await tx.purchaseOrderItem.findMany({
              where: { id: { in: poItemIds } },
              select: { id: true, quantityOrdered: true, quantityReceived: true, quantityShort: true },
            })
          : [];
        const remainingById = new Map(
          currentItems.map((i) => [i.id, remainingQuantityFor(i)]),
        );
        const requestedByItem = new Map<string, number>();
        for (const item of receipt.items) {
          if (item.actualQty.lte(0)) continue;
          requestedByItem.set(
            item.purchaseOrderItemId,
            (requestedByItem.get(item.purchaseOrderItemId) ?? 0) + item.actualQty.toNumber(),
          );
        }
        for (const [poItemId, requested] of requestedByItem) {
          const remaining = remainingById.get(poItemId) ?? 0;
          if (requested > remaining) {
            throw new AppError(
              422,
              ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
              "Receipt quantity exceeds the remaining quantity on the purchase order item",
              {
                purchaseOrderItemId: poItemId,
                remainingQuantity: remaining,
                requestedQuantity: requested,
              },
            );
          }
        }

        // Track requirement lines that receive goods so we can recompute
        // requirement status after the items loop (below).
        const affectedRequirementIds = new Set<string>();

        for (const item of receipt.items) {
          if (item.actualQty.lte(0)) continue;

          const batchNumber = item.batchNumber!;
          const expiryDate = item.expiryDate!;
          const manufacturingDate = item.manufacturingDate;

          let batch = await tx.batch.findUnique({
            where: { productId_batchNumber: { productId: item.purchaseOrderItem.productId, batchNumber } },
            select: { id: true },
          });

          if (!batch) {
            batch = await tx.batch.create({
              data: {
                productId: item.purchaseOrderItem.productId,
                batchNumber,
                manufacturingDate: manufacturingDate ? toUtcDay(manufacturingDate) : null,
                receivedDate: toUtcDay(receipt.receivedDate),
                expiryDate: toUtcDay(expiryDate),
                purchaseCost: item.unitCost,
                supplierId,
              },
            });
          }

          // The receipt quantities are expressed in the PO item's ordered unit.
          // Convert to BASE via the PO item's snapshotted ordered quantity and
          // ordered-base pair so the movement lands in canonical base units
          // without ever re-reading the live ProductUnit configuration.
          const orderedQty = item.purchaseOrderItem.quantityOrdered;
          const orderedBaseQty = item.purchaseOrderItem.quantityOrderedBase;
          const unitFactor =
            orderedQty.gt(0) && orderedBaseQty?.gt(0) ? orderedBaseQty.div(orderedQty) : null;
          const movementQuantity = roundTo(
            toDecimal(item.actualQty).mul(unitFactor ?? 1),
            3,
          );

          // Stock movement inside the SAME transaction ( PURCHASE IN).
          await recordMovementInTransaction(tx, {
            productId: item.purchaseOrderItem.productId,
            batchId: batch.id,
            locationId: item.locationId,
            transactionType: "PURCHASE",
            direction: "IN",
            quantity: movementQuantity,
            // Conversion snapshot for historical traceability — same unit the
            // receipt snapshotted at receipt time. Legacy PO items without a
            // base snapshot fall back to factor 1 (interpreted as base).
            unitId: item.unitId,
            conversionFactor: unitFactor ?? 1,
            referenceType: "GoodsReceipt",
            referenceId: receipt.id,
            notes: `Receipt ${receipt.receiptNumber} - PO ${receipt.purchaseOrder.poNumber}`,
            actor,
          });

          // Cumulative increment — never overwrites earlier receipts.
          await tx.purchaseOrderItem.update({
            where: { id: item.purchaseOrderItemId },
            data: {
              quantityReceived: { increment: item.actualQty },
            },
          });

          await tx.goodsReceiptItem.update({
            where: { id: item.id },
            data: { batchId: batch.id },
          });

          // Track received quantity for the requirement line. Receiving is downstream
          // of ordering: it must never release an allocation or rewrite the
          // requirement's fulfillment status. Accepted shortages intentionally do
          // NOT touch quantityDelivered — shortage units were never fulfilled.
          if (item.purchaseOrderItem.requirementLineId) {
            await tx.purchaseRequirementLine.update({
              where: { id: item.purchaseOrderItem.requirementLineId },
              data: {
                quantityDelivered: { increment: item.actualQty },
              },
            });
            affectedRequirementIds.add(item.purchaseOrderItem.requirementLineId);
          }
        }

        // Recalculate the PO status from ALL items through the single shared
        // helper: RECEIVED only when nothing remains on any item, otherwise
        // PARTIALLY_RECEIVED / AWAITING_DELIVERY.
        await calculatePurchaseOrderStatus(receipt.purchaseOrderId, tx);

        // Recompute requirement status for every line that received goods.
        // This is the trigger that turns a requirement from OPEN/PARTIALLY_FULFILLED
        // to FULFILLED once actual delivered quantity meets the required quantity.
        if (affectedRequirementIds.size > 0) {
          const reqLines = await tx.purchaseRequirementLine.findMany({
            where: { id: { in: [...affectedRequirementIds] } },
            select: { requirementId: true },
          });
          for (const requirementId of new Set(reqLines.map((l) => l.requirementId))) {
            await recomputeRequirementStatus(requirementId, tx);
          }
        }

        // Audit in the SAME transaction: the confirmed receipt, its stock
        // movements, PO quantity updates and this event commit or roll back
        // as one unit.
        await recordAuditEvent(
          {
            event: AuditEvent.GOODS_RECEIPT_CONFIRMED,
            entityId: id,
            actorId: actor.id,
            metadata: {
              receiptNumber: receipt.receiptNumber,
              purchaseOrderId: receipt.purchaseOrderId,
              supplierId,
              itemCount: receipt.items.length,
            },
          },
          tx,
        );

        return tx.goodsReceipt.findUnique({
          where: { id },
          include: {
            purchaseOrder: { select: { id: true, poNumber: true, status: true } },
            items: {
              include: {
                purchaseOrderItem: {
                  select: { id: true, productId: true, quantityOrdered: true, quantityReceived: true, quantityShort: true },
                },
                location: { select: { id: true, name: true } },
                batch: { select: { id: true, batchNumber: true, expiryDate: true } },
              },
            },
          },
        });
    };

    if (externalTx) {
      return run(externalTx);
    }
    return prisma.$transaction(run, { timeout: 30_000, maxWait: 15_000 });
  },

  async remove(id: string, actor?: Pick<AuthenticatedUser, "id">) {
    const receipt = await prisma.goodsReceipt.findUnique({
      where: { id },
      select: { id: true, receiptNumber: true, status: true, confirmedById: true },
    });
    if (!receipt) {
      throw new AppError(404, ErrorCode.GOODS_RECEIPT_NOT_FOUND, "Goods receipt not found");
    }
    if (receipt.confirmedById) {
      throw new AppError(409, ErrorCode.GOODS_RECEIPT_ALREADY_CONFIRMED, "Cannot delete a confirmed goods receipt");
    }

    await prisma.goodsReceipt.delete({ where: { id } });

    await recordAuditEvent({
      event: AuditEvent.GOODS_RECEIPT_DELETED,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: { receiptNumber: receipt.receiptNumber },
    });
  },
};