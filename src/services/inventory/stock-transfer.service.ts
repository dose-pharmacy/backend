import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { recordMovementInTransaction } from "./stock-movement.service.js";
import { productUnitService } from "./product-unit.service.js";
import { toDecimal } from "../../utils/decimal.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type TransferStatus = "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED";

/**
 * A transfer line item.
 *   quantity     = the quantity entered by the user (in `unit`)
 *   unitId       = the master unit the user selected (e.g. "Box")
 *   baseQuantity = quantity normalised to the product base unit using the
 *                  ProductUnit conversion factor AT ENTRY TIME. Stock
 *                  movements always use baseQuantity; the entered
 *                  quantity/unit are preserved for auditability and are
 *                  never recomputed from the (possibly changed) ProductUnit.
 */
export type TransferItemInput = {
  productId: string;
  batchId: string;
  unitId: string;
  quantity: number;
};

export type UpdateTransferItemInput = Partial<
  Pick<TransferItemInput, "unitId" | "quantity">
>;

export type CreateTransferInput = {
  fromLocationId: string;
  toLocationId: string;
  transferDate?: Date;
  reason?: string;
  items?: TransferItemInput[];
};

export type UpdateTransferInput = Partial<{
  fromLocationId: string;
  toLocationId: string;
  transferDate: Date;
  reason: string | null;
}>;

export type ListTransfersQuery = PageQuery & {
  status?: TransferStatus;
  fromLocationId?: string;
  toLocationId?: string;
};

const transferDetailInclude = {
  fromLocation: { select: { id: true, name: true, isActive: true } },
  toLocation: { select: { id: true, name: true, isActive: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      batch: { select: { id: true, batchNumber: true, expiryDate: true } },
      unit: { select: { id: true, name: true, symbol: true } },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.StockTransferInclude;

async function assertLocationExists(
  tx: Prisma.TransactionClient | typeof prisma,
  id: string,
): Promise<void> {
  const location = await tx.inventoryLocation.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!location) {
    throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
  }
  if (!location.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_LOCATION, "Location is not active");
  }
}

async function assertBatchProductMatch(
  tx: Prisma.TransactionClient | typeof prisma,
  batchId: string,
  productId: string,
): Promise<void> {
  const batch = await tx.batch.findUnique({
    where: { id: batchId },
    select: { id: true, productId: true, batchNumber: true },
  });
  if (!batch) {
    throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
  }
  if (batch.productId !== productId) {
    throw new AppError(
      422,
      ErrorCode.BATCH_PRODUCT_MISMATCH,
      "Batch does not belong to the given product",
    );
  }
}

/**
 * Validates one transfer item and computes its base quantity through
 * productUnitService.toBaseQuantity (the single unit-conversion authority):
 *   - batch exists and belongs to the product
 *   - unit exists, is active and is configured for the product
 *   - quantity > 0 and conversion produces a positive base quantity
 */
async function validateAndConvertItem(
  tx: Prisma.TransactionClient | typeof prisma,
  item: TransferItemInput,
): Promise<Prisma.Decimal> {
  await assertBatchProductMatch(tx, item.batchId, item.productId);

  // toBaseQuantity validates the product/unit relationship, unit activity
  // and positive quantities, and performs the conversion inside `tx`.
  const { baseQuantity } = await productUnitService.toBaseQuantity(
    item.productId,
    item.unitId,
    item.quantity,
    tx,
  );
  return baseQuantity;
}

async function assertTransferEditable(transfer: {
  id: string;
  status: string;
}): Promise<void> {
  if (transfer.status === "COMPLETED" || transfer.status === "CANCELLED") {
    throw new AppError(
      409,
      ErrorCode.TRANSFER_NOT_EDITABLE,
      "Cannot modify a completed or cancelled transfer",
    );
  }
}

export const stockTransferService = {
  async list(query: ListTransfersQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.StockTransferWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.fromLocationId ? { fromLocationId: query.fromLocationId } : {}),
      ...(query.toLocationId ? { toLocationId: query.toLocationId } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.stockTransfer.findMany({
        where,
        include: transferDetailInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.stockTransfer.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id },
      include: transferDetailInclude,
    });
    if (!transfer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
    }
    return transfer;
  },

  async create(input: CreateTransferInput, actor: Pick<AuthenticatedUser, "id">) {
    if (input.fromLocationId === input.toLocationId) {
      throw new AppError(
        422,
        ErrorCode.BAD_REQUEST,
        "Source and destination locations cannot be the same",
      );
    }

    return prisma.$transaction(
      async (tx) => {
        await Promise.all([
          assertLocationExists(tx, input.fromLocationId),
        assertLocationExists(tx, input.toLocationId),
      ]);

      const seen = new Set<string>();
      const items = [];
      for (const item of input.items ?? []) {
        const key = `${item.productId}:${item.batchId}:${item.unitId}`;
        if (seen.has(key)) {
          throw new AppError(
            409,
            ErrorCode.DUPLICATE_TRANSFER_ITEM,
            "The same product + batch + unit cannot appear twice in a transfer",
          );
        }
        seen.add(key);
        const baseQuantity = await validateAndConvertItem(tx, item);
        items.push({ item, baseQuantity });
      }

      const transfer = await tx.stockTransfer.create({
        data: {
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          transferDate: input.transferDate ?? new Date(),
          reason: input.reason,
          status: "DRAFT",
          createdById: actor.id,
          items: {
            create: items.map(({ item, baseQuantity }) => ({
              productId: item.productId,
              batchId: item.batchId,
              unitId: item.unitId,
              quantity: toDecimal(item.quantity),
              baseQuantity,
            })),
          },
        },
        include: transferDetailInclude,
      });

      return transfer;
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    });
  },

  /**
   * Generic transfer update. Does NOT touch items (dedicated item endpoints)
   * and does NOT allow changing the status — state transitions happen only
   * through POST /transfers/:id/complete and POST /transfers/:id/cancel.
   */
  async update(id: string, input: UpdateTransferInput) {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!transfer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
    }
    await assertTransferEditable(transfer);

    if (input.fromLocationId && input.toLocationId && input.fromLocationId === input.toLocationId) {
      throw new AppError(
        422,
        ErrorCode.BAD_REQUEST,
        "Source and destination locations cannot be the same",
      );
    }

    if (input.fromLocationId) {
      await assertLocationExists(prisma, input.fromLocationId);
    }
    if (input.toLocationId) {
      await assertLocationExists(prisma, input.toLocationId);
    }

    return prisma.stockTransfer.update({
      where: { id },
      data: {
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        transferDate: input.transferDate,
        reason: input.reason,
      },
      include: transferDetailInclude,
    });
  },

  // ---------------------------------------------------------------------------
  // Draft item editing
  // ---------------------------------------------------------------------------

  async addItem(transferId: string, input: TransferItemInput) {
    return prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        select: { id: true, status: true },
      });
      if (!transfer) {
        throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
      }
      await assertTransferEditable(transfer);

      const duplicate = await tx.stockTransferItem.findFirst({
        where: { transferId, productId: input.productId, batchId: input.batchId, unitId: input.unitId },
        select: { id: true },
      });
      if (duplicate) {
        throw new AppError(
          409,
          ErrorCode.DUPLICATE_TRANSFER_ITEM,
          "The same product + batch + unit already exists in this transfer",
        );
      }

      const baseQuantity = await validateAndConvertItem(tx, input);

      return tx.stockTransferItem.create({
        data: {
          transferId,
          productId: input.productId,
          batchId: input.batchId,
          unitId: input.unitId,
          quantity: toDecimal(input.quantity),
          baseQuantity,
        },
        include: {
          product: { select: { id: true, name: true, sku: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          unit: { select: { id: true, name: true, symbol: true } },
        },
      });
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    });
  },

  async updateItem(transferId: string, itemId: string, input: UpdateTransferItemInput) {
    return prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        select: { id: true, status: true },
      });
      if (!transfer) {
        throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
      }
      await assertTransferEditable(transfer);

      const item = await tx.stockTransferItem.findUnique({
        where: { id: itemId },
      });
      if (!item || item.transferId !== transferId) {
        throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer item not found");
      }

      const next: TransferItemInput = {
        productId: item.productId,
        batchId: item.batchId,
        unitId: input.unitId ?? item.unitId,
        quantity: input.quantity ?? item.quantity.toNumber(),
      };

      const baseQuantity = await validateAndConvertItem(tx, next);

      // Duplicate check: another item in this transfer with the same
      // product + batch + unit combination.
      if (input.unitId !== undefined || input.quantity !== undefined) {
        const duplicate = await tx.stockTransferItem.findFirst({
          where: {
            transferId,
            productId: next.productId,
            batchId: next.batchId,
            unitId: next.unitId,
            id: { not: itemId },
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new AppError(
            409,
            ErrorCode.DUPLICATE_TRANSFER_ITEM,
            "The same product + batch + unit already exists in this transfer",
          );
        }
      }

      return tx.stockTransferItem.update({
        where: { id: itemId },
        data: {
          unitId: next.unitId,
          quantity: toDecimal(next.quantity),
          baseQuantity,
        },
        include: {
          product: { select: { id: true, name: true, sku: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          unit: { select: { id: true, name: true, symbol: true } },
        },
      });
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    });
  },

  async removeItem(transferId: string, itemId: string) {
    return prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        select: { id: true, status: true },
      });
      if (!transfer) {
        throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
      }
      await assertTransferEditable(transfer);

      const item = await tx.stockTransferItem.findUnique({
        where: { id: itemId },
        select: { id: true, transferId: true },
      });
      if (!item || item.transferId !== transferId) {
        throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer item not found");
      }

      await tx.stockTransferItem.delete({ where: { id: itemId } });
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    });
  },

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Completes a transfer atomically in ONE transaction:
   *
   *   validate transfer / locations / items
   *   for each item: validate source stock using stored baseQuantity
   *   for each item: record TRANSFER_OUT + TRANSFER_IN (base units)
   *   update status = COMPLETED
   *
   * If any step fails, OUT + IN + status all roll back — the database can
   * never end up with stock moved but the transfer still DRAFT/PENDING, or
   * the transfer COMPLETED but the stock movement failed.
   */
  async complete(id: string, actor: Pick<AuthenticatedUser, "id">) {
    await prisma.$transaction(
      async (tx) => {
        const transfer = await tx.stockTransfer.findUnique({
          where: { id },
          include: {
            items: {
              include: {
                batch: { select: { id: true, batchNumber: true } },
              },
            },
          },
        });

        if (!transfer) {
          throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
        }
        if (transfer.status === "COMPLETED") {
          throw new AppError(409, ErrorCode.CONFLICT, "Transfer already completed");
        }
        if (transfer.status === "CANCELLED") {
          throw new AppError(409, ErrorCode.CONFLICT, "Cannot complete a cancelled transfer");
        }

        await Promise.all([
          assertLocationExists(tx, transfer.fromLocationId),
          assertLocationExists(tx, transfer.toLocationId),
        ]);

        if (transfer.items.length === 0) {
          throw new AppError(
            422,
            ErrorCode.INVALID_STOCK_QUANTITY,
            "Cannot complete a transfer without items",
          );
        }

        // Validate source stock availability for all items using the
        // persisted base quantities (the exact conversion used at entry time).
        for (const item of transfer.items) {
          if (item.baseQuantity.lte(0)) {
            throw new AppError(
              422,
              ErrorCode.INVALID_STOCK_QUANTITY,
              `Invalid base quantity for batch ${item.batch.batchNumber}`,
            );
          }
          const stock = await tx.inventoryStock.findUnique({
            where: {
              batchId_locationId: {
                batchId: item.batchId,
                locationId: transfer.fromLocationId,
              },
            },
          });
          if (!stock || stock.quantity.lessThan(item.baseQuantity)) {
            throw new AppError(
              409,
              ErrorCode.INSUFFICIENT_STOCK,
              `Insufficient stock for batch ${item.batch.batchNumber} at source location`,
              { available: stock?.quantity.toNumber() ?? 0, requested: item.baseQuantity.toNumber() },
            );
          }
        }

        // Execute the movements + status update atomically. Both directions
        // use the SAME transaction as the status update via
        // recordMovementInTransaction (no nested transactions).
        for (const item of transfer.items) {
          await recordMovementInTransaction(tx, {
            productId: item.productId,
            batchId: item.batchId,
            locationId: transfer.fromLocationId,
            transactionType: "TRANSFER_OUT",
            direction: "OUT",
            quantity: item.baseQuantity,
            referenceType: "StockTransfer",
            referenceId: transfer.id,
            notes: `Transfer to ${transfer.toLocationId}`,
            actor,
          });

          await recordMovementInTransaction(tx, {
            productId: item.productId,
            batchId: item.batchId,
            locationId: transfer.toLocationId,
            transactionType: "TRANSFER_IN",
            direction: "IN",
            quantity: item.baseQuantity,
            referenceType: "StockTransfer",
            referenceId: transfer.id,
            notes: `Transfer from ${transfer.fromLocationId}`,
            actor,
          });
        }

        await tx.stockTransfer.update({
          where: { id },
          data: { status: "COMPLETED" },
        });
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    return this.getById(id);
  },

  async cancel(id: string, _actor: Pick<AuthenticatedUser, "id">) {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!transfer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
    }

    if (transfer.status === "CANCELLED") {
      throw new AppError(409, ErrorCode.CONFLICT, "Transfer already cancelled");
    }
    if (transfer.status === "COMPLETED") {
      throw new AppError(409, ErrorCode.CONFLICT, "Cannot cancel a completed transfer");
    }

    await prisma.stockTransfer.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return this.getById(id);
  },
};