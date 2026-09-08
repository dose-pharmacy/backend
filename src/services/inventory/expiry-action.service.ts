import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { stockMovementService } from "./stock-movement.service.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type ExpiryActionType = "RETURN_TO_SUPPLIER" | "CLEARANCE_SALE" | "DISPOSE";

export type CreateExpiryActionInput = {
  batchId: string;
  actionType: ExpiryActionType;
  quantity?: number;
  locationId?: string;
  supplierId?: string;
  discountPercent?: number;
  reason?: string;
  notes?: string;
};

export type ListExpiryActionsQuery = PageQuery & {
  batchId?: string;
  actionType?: ExpiryActionType;
};

async function assertBatchExists(batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, productId: true, expiryDate: true },
  });
  if (!batch) {
    throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
  }
  return batch;
}

async function assertLocationExists(locationId: string) {
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

export const expiryActionService = {
  async list(query: ListExpiryActionsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.ExpiryActionWhereInput = {
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.expiryAction.findMany({
        where,
        include: {
          batch: {
            select: { id: true, batchNumber: true, productId: true, expiryDate: true },
          },
          location: { select: { id: true, name: true } },
          performedBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.expiryAction.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateExpiryActionInput, actor: Pick<AuthenticatedUser, "id">) {
    const batch = await assertBatchExists(input.batchId);

    // For RETURN_TO_SUPPLIER and DISPOSE, quantity and location are required
    if (input.actionType === "RETURN_TO_SUPPLIER" || input.actionType === "DISPOSE") {
      if (!input.quantity || input.quantity <= 0) {
        throw new AppError(422, ErrorCode.INVALID_STOCK_QUANTITY, "Quantity must be greater than zero");
      }
      if (!input.locationId) {
        throw new AppError(422, ErrorCode.BAD_REQUEST, "Location is required for this action");
      }
      await assertLocationExists(input.locationId);

      // Check available stock at location
      const stock = await inventoryStockRepository.findByBatchAndLocation(input.batchId, input.locationId);
      if (!stock || stock.quantity.lessThan(input.quantity)) {
        throw new AppError(
          409,
          ErrorCode.INSUFFICIENT_STOCK,
          "Insufficient stock for this action",
          { available: stock?.quantity.toNumber() ?? 0, requested: input.quantity },
        );
      }
    }

    // For CLEARANCE_SALE, discountPercent is optional but can be provided
    if (input.actionType === "CLEARANCE_SALE") {
      if (input.discountPercent !== undefined && (input.discountPercent < 0 || input.discountPercent > 100)) {
        throw new AppError(422, ErrorCode.BAD_REQUEST, "Discount percent must be between 0 and 100");
      }
    }

    // Execute action
    if (input.actionType === "DISPOSE") {
      return prisma.$transaction(async (tx) => {
        // Record stock movement (DISPOSAL OUT)
        await stockMovementService.recordMovement({
          productId: batch.productId,
          batchId: input.batchId,
          locationId: input.locationId!,
          transactionType: "DISPOSAL",
          direction: "OUT",
          quantity: input.quantity!,
          referenceType: "ExpiryAction",
          referenceId: null, // Will be set after expiry action is created
          notes: input.reason ?? "Disposal of expired/near-expiry stock",
          actor,
        });

        // Create expiry action record
        const action = await tx.expiryAction.create({
          data: {
            batchId: input.batchId,
            actionType: input.actionType,
            quantity: input.quantity!,
            locationId: input.locationId!,
            supplierId: input.supplierId ?? null,
            discountPercent: input.discountPercent ?? null,
            reason: input.reason ?? null,
            notes: input.notes ?? null,
            performedById: actor.id,
          },
        });

        // Update the stock transaction with the referenceId
        await tx.stockTransaction.updateMany({
          where: {
            referenceType: "ExpiryAction",
            referenceId: null,
            batchId: input.batchId,
            locationId: input.locationId!,
            createdById: actor.id,
          },
          data: { referenceId: action.id },
        });

        return action;
      });
    }

    if (input.actionType === "RETURN_TO_SUPPLIER") {
      return prisma.$transaction(async (tx) => {
        // Record stock movement (RETURN_OUT)
        await stockMovementService.recordMovement({
          productId: batch.productId,
          batchId: input.batchId,
          locationId: input.locationId!,
          transactionType: "RETURN_TO_SUPPLIER",
          direction: "OUT",
          quantity: input.quantity!,
          referenceType: "ExpiryAction",
          referenceId: null,
          notes: input.reason ?? "Return to supplier",
          actor,
        });

        // Create expiry action record
        const action = await tx.expiryAction.create({
          data: {
            batchId: input.batchId,
            actionType: input.actionType,
            quantity: input.quantity!,
            locationId: input.locationId!,
            supplierId: input.supplierId ?? null,
            discountPercent: null,
            reason: input.reason ?? null,
            notes: input.notes ?? null,
            performedById: actor.id,
          },
        });

        // Update the stock transaction with the referenceId
        await tx.stockTransaction.updateMany({
          where: {
            referenceType: "ExpiryAction",
            referenceId: null,
            batchId: input.batchId,
            locationId: input.locationId!,
            createdById: actor.id,
          },
          data: { referenceId: action.id },
        });

        return action;
      });
    }

    // CLEARANCE_SALE - does not reduce stock, just records the action
    const action = await prisma.expiryAction.create({
      data: {
        batchId: input.batchId,
        actionType: input.actionType,
        quantity: null,
        locationId: null,
        supplierId: null,
        discountPercent: input.discountPercent ?? null,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        performedById: actor.id,
      },
    });

    return action;
  },
};