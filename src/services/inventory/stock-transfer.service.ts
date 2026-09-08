import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { stockMovementService } from "./stock-movement.service.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type TransferStatus = "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED";

export type CreateTransferInput = {
  fromLocationId: string;
  toLocationId: string;
  transferDate?: Date;
  reason?: string;
  items: Array<{
    productId: string;
    batchId: string;
    quantity: number;
  }>;
};

export type UpdateTransferInput = Partial<{
  fromLocationId: string;
  toLocationId: string;
  transferDate: Date;
  reason: string | null;
  status: TransferStatus;
}>;

export type ListTransfersQuery = PageQuery & {
  status?: TransferStatus;
  fromLocationId?: string;
  toLocationId?: string;
};

export type TransferItemInput = {
  productId: string;
  batchId: string;
  quantity: number;
};

async function assertLocationExists(id: string): Promise<void> {
  const location = await prisma.inventoryLocation.findUnique({
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

async function assertBatchProductMatch(batchId: string, productId: string): Promise<void> {
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
        include: {
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, sku: true } },
              batch: { select: { id: true, batchNumber: true, expiryDate: true } },
            },
          },
        },
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
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          },
        },
      },
    });
    if (!transfer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
    }
    return transfer;
  },

  async create(input: CreateTransferInput, actor: Pick<AuthenticatedUser, "id">) {
    // Validate source and destination are different
    if (input.fromLocationId === input.toLocationId) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Source and destination locations cannot be the same");
    }

    // Validate locations exist and are active
    await Promise.all([
      assertLocationExists(input.fromLocationId),
      assertLocationExists(input.toLocationId),
    ]);

    // Validate each item
    for (const item of input.items) {
      await assertBatchProductMatch(item.batchId, item.productId);
      if (item.quantity <= 0) {
        throw new AppError(422, ErrorCode.INVALID_STOCK_QUANTITY, "Quantity must be greater than zero");
      }
    }

    const transfer = await prisma.stockTransfer.create({
      data: {
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        transferDate: input.transferDate ?? new Date(),
        reason: input.reason,
        status: "DRAFT",
        createdById: actor.id,
        items: {
          create: input.items.map((item) => ({
            productId: item.productId,
            batchId: item.batchId,
            quantity: item.quantity,
          })),
        },
      },
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          },
        },
      },
    });

    return transfer;
  },

  async update(id: string, input: UpdateTransferInput) {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!transfer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, "Transfer not found");
    }

    // Cannot update completed or cancelled transfers
    if (transfer.status === "COMPLETED" || transfer.status === "CANCELLED") {
      throw new AppError(409, ErrorCode.CONFLICT, "Cannot modify a completed or cancelled transfer");
    }

    // If changing locations, validate they are different
    if (input.fromLocationId && input.toLocationId && input.fromLocationId === input.toLocationId) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Source and destination locations cannot be the same");
    }

    if (input.fromLocationId) {
      await assertLocationExists(input.fromLocationId);
    }
    if (input.toLocationId) {
      await assertLocationExists(input.toLocationId);
    }

    return prisma.stockTransfer.update({
      where: { id },
      data: {
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        transferDate: input.transferDate,
        reason: input.reason,
        status: input.status,
      },
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          },
        },
      },
    });
  },

  async complete(id: string, actor: Pick<AuthenticatedUser, "id">) {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            batch: { select: { id: true, productId: true, expiryDate: true, batchNumber: true } },
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

    // Validate source stock availability for all items
    for (const item of transfer.items) {
      const stock = await inventoryStockRepository.findByBatchAndLocation(
        item.batchId,
        transfer.fromLocationId,
      );
      if (!stock || stock.quantity.lessThan(item.quantity)) {
        throw new AppError(
          409,
          ErrorCode.INSUFFICIENT_STOCK,
          `Insufficient stock for batch ${item.batch.batchNumber} at source location`,
          { available: stock?.quantity.toNumber() ?? 0, requested: item.quantity.toNumber() },
        );
      }
    }

    // Execute transfer atomically
    await prisma.$transaction(async (tx) => {
      for (const item of transfer.items) {
        // TRANSFER_OUT from source location
        await stockMovementService.recordMovement({
          productId: item.productId,
          batchId: item.batchId,
          locationId: transfer.fromLocationId,
          transactionType: "TRANSFER_OUT",
          direction: "OUT",
          quantity: item.quantity,
          referenceType: "StockTransfer",
          referenceId: transfer.id,
          notes: `Transfer to ${transfer.toLocationId}`,
          actor,
        });

        // TRANSFER_IN to destination location
        await stockMovementService.recordMovement({
          productId: item.productId,
          batchId: item.batchId,
          locationId: transfer.toLocationId,
          transactionType: "TRANSFER_IN",
          direction: "IN",
          quantity: item.quantity,
          referenceType: "StockTransfer",
          referenceId: transfer.id,
          notes: `Transfer from ${transfer.fromLocationId}`,
          actor,
        });
      }

      // Update transfer status
      await tx.stockTransfer.update({
        where: { id },
        data: { status: "COMPLETED" },
      });
    });

    return this.getById(id);
  },

  async cancel(id: string, actor: Pick<AuthenticatedUser, "id">) {
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