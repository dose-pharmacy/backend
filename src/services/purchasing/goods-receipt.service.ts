import { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { recordMovementInTransaction } from "../inventory/stock-movement.service.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { addUtcDays, startOfTodayUtc, toUtcDay } from "../../utils/date-time.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreateGRInput = {
  purchaseOrderId: string;
  receivedDate?: Date;
  discrepancyNote?: string | null;
  items: Array<{
    purchaseOrderItemId: string;
    locationId: string;
    deliveredQty: number;
    actualQty: number;
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

async function assertPOExistsAndValid(poId: string) {
  const po = await prisma.purchaseOrder.findUnique({
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

async function assertPOItemBelongsToPO(poItemId: string, poId: string) {
  const item = await prisma.purchaseOrderItem.findUnique({
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

  async create(input: CreateGRInput, actor: Pick<AuthenticatedUser, "id">) {
    const po = await assertPOExistsAndValid(input.purchaseOrderId);

    // Validate each item
    const validatedItems = [];
    for (const item of input.items) {
      // Check PO item belongs to PO
      const poItem = await assertPOItemBelongsToPO(item.purchaseOrderItemId, input.purchaseOrderId);

      // Check location
      await assertLocationActive(item.locationId);

      // Compute expected qty = remaining on PO item. Accepted shortages reduce
      // the outstanding expectation: they are already reconciled against the order.
      const expectedQty =
        Number(poItem.quantityOrdered) -
        Number(poItem.quantityReceived) -
        Number(poItem.quantityShort);

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
      if (item.actualQty > expectedQty) {
        throw new AppError(
          422,
          ErrorCode.GR_ITEM_QUANTITY_MISMATCH,
          "Actual quantity exceeds the remaining quantity on the purchase order item",
          { remainingQuantity: expectedQty, requestedQuantity: item.actualQty },
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

      validatedItems.push({
        ...item,
        expectedQty,
        poItem,
      });
    }

    // Compute status
    const status = computeGRStatus(
      validatedItems.map((i) => ({ expectedQty: i.expectedQty, deliveredQty: i.deliveredQty, actualQty: i.actualQty }))
    );

    const receipt = await prisma.goodsReceipt.create({
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

    await recordAuditEvent({
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
    });

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
  async confirm(id: string, actor: Pick<AuthenticatedUser, "id">) {
    return prisma.$transaction(
      async (tx) => {
        const receipt = await tx.goodsReceipt.findUnique({
          where: { id },
          include: {
            purchaseOrder: {
              select: { id: true, poNumber: true, status: true, supplierId: true },
            },
            items: {
              include: {
                purchaseOrderItem: {
                  select: { id: true, productId: true, requirementLineId: true },
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

          // Stock movement inside the SAME transaction ( PURCHASE IN).
          await recordMovementInTransaction(tx, {
            productId: item.purchaseOrderItem.productId,
            batchId: batch.id,
            locationId: item.locationId,
            transactionType: "PURCHASE",
            direction: "IN",
            quantity: item.actualQty,
            // Conversion snapshot for historical traceability.
            unitId: item.unitId,
            conversionFactor: 1,
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
          }
        }

        // PO status: RECEIVED once every item is fully accounted for
        // (received + accepted short >= ordered); otherwise AWAITING_DELIVERY.
        const poItems = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: receipt.purchaseOrderId },
          select: { id: true, quantityOrdered: true, quantityReceived: true, quantityShort: true },
        });
        const allAccountedFor = poItems.every(
          (i) => i.quantityReceived.plus(i.quantityShort).gte(i.quantityOrdered),
        );
        await tx.purchaseOrder.update({
          where: { id: receipt.purchaseOrderId },
          data: {
            status: allAccountedFor ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.AWAITING_DELIVERY,
          },
        });

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
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
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