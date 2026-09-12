import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { stockMovementService } from "../inventory/stock-movement.service.js";
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
    select: { id: true, purchaseOrderId: true, productId: true, quantityOrdered: true, quantityReceived: true, unitCost: true },
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

    const [items, total] = await prisma.$transaction([
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
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
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

      // Compute expected qty = remaining on PO item
      const expectedQty = Number(poItem.quantityOrdered) - Number(poItem.quantityReceived);

      // Validate actualQty > 0
      if (item.actualQty <= 0) {
        throw new AppError(422, ErrorCode.GR_ITEM_QUANTITY_MISMATCH, "Actual quantity must be greater than zero");
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
          },
        },
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

  async resolve(id: string, input: ResolveGRInput) {
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

    return prisma.goodsReceipt.update({
      where: { id },
      data: {
        status: newStatus,
        discrepancyNote: input.discrepancyNote ?? undefined,
      },
    });
  },

  async confirm(id: string, actor: Pick<AuthenticatedUser, "id">) {
    const receipt = await prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        purchaseOrder: {
          select: { id: true, poNumber: true, status: true, supplierId: true, items: { select: { id: true, productId: true, quantityOrdered: true, quantityReceived: true } } },
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

    const supplierId = receipt.purchaseOrder.supplierId;

    // Process each item with actualQty > 0
    for (const item of receipt.items) {
      if (item.actualQty.lte(0)) continue;

      const batchNumber = item.batchNumber!;
      const expiryDate = item.expiryDate!;
      const manufacturingDate = item.manufacturingDate;

      // Upsert batch
      let batch = await prisma.batch.findUnique({
        where: { productId_batchNumber: { productId: item.purchaseOrderItem.productId, batchNumber } },
        select: { id: true },
      });

      if (!batch) {
        batch = await prisma.batch.create({
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

      // Record stock movement (PURCHASE IN)
      await stockMovementService.recordMovement({
        productId: item.purchaseOrderItem.productId,
        batchId: batch.id,
        locationId: item.locationId,
        transactionType: "PURCHASE",
        direction: "IN",
        quantity: item.actualQty,
        referenceType: "GoodsReceipt",
        referenceId: receipt.id,
        notes: `Receipt ${receipt.receiptNumber} - PO ${receipt.purchaseOrder.poNumber}`,
        actor,
      });

      // Update PO item quantityReceived
      await prisma.purchaseOrderItem.update({
        where: { id: item.purchaseOrderItemId },
        data: {
          quantityReceived: { increment: item.actualQty },
        },
      });

      // Update GR item with batchId
      await prisma.goodsReceiptItem.update({
        where: { id: item.id },
        data: { batchId: batch.id },
      });

      // Update requirement line quantityDelivered
      if (item.purchaseOrderItem.requirementLineId) {
        await prisma.purchaseRequirementLine.update({
          where: { id: item.purchaseOrderItem.requirementLineId },
          data: {
            quantityDelivered: { increment: item.actualQty },
          },
        });

        // Check if requirement line is fulfilled
        const reqLine = await prisma.purchaseRequirementLine.findUnique({
          where: { id: item.purchaseOrderItem.requirementLineId },
          select: { id: true, requirementId: true, quantityNeeded: true, quantityDelivered: true },
        });
        if (reqLine && reqLine.quantityDelivered >= reqLine.quantityNeeded) {
          await prisma.purchaseRequirementLine.update({
            where: { id: reqLine.id },
            data: { status: "CLOSED" },
          });

          // Recompute requirement header status
          const lines = await prisma.purchaseRequirementLine.findMany({
            where: { requirementId: reqLine.requirementId },
            select: { status: true },
          });
          let newStatus: "OPEN" | "ASSIGNED" | "CLOSED";
          if (lines.every((l) => l.status === "CLOSED")) newStatus = "CLOSED";
          else if (lines.some((l) => l.status === "ASSIGNED")) newStatus = "ASSIGNED";
          else newStatus = "OPEN";

          await prisma.purchaseRequirement.update({
            where: { id: reqLine.requirementId },
            data: { status: newStatus },
          });
        }
      }
    }

    // Check if all PO items fully received
    const poItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: receipt.purchaseOrderId },
      select: { id: true, quantityOrdered: true, quantityReceived: true },
    });
    const allReceived = poItems.every((i) => i.quantityReceived >= i.quantityOrdered);

    // Update PO status
    if (allReceived) {
      await prisma.purchaseOrder.update({
        where: { id: receipt.purchaseOrderId },
        data: { status: "RECEIVED" },
      });
    } else {
      // If some received but not all, ensure status is AWAITING_DELIVERY
      await prisma.purchaseOrder.update({
        where: { id: receipt.purchaseOrderId },
        data: { status: "AWAITING_DELIVERY" },
      });
    }

    // Mark receipt as confirmed
    return prisma.goodsReceipt.update({
      where: { id },
      data: {
        confirmedById: actor.id,
        status: "MATCHED",
      },
    });
  },

  async remove(id: string) {
    const receipt = await prisma.goodsReceipt.findUnique({
      where: { id },
      select: { id: true, status: true, confirmedById: true },
    });
    if (!receipt) {
      throw new AppError(404, ErrorCode.GOODS_RECEIPT_NOT_FOUND, "Goods receipt not found");
    }
    if (receipt.confirmedById) {
      throw new AppError(409, ErrorCode.GOODS_RECEIPT_ALREADY_CONFIRMED, "Cannot delete a confirmed goods receipt");
    }

    await prisma.goodsReceipt.delete({ where: { id } });
  },
};