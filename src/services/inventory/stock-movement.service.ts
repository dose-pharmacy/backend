import {
  Prisma,
  StockDirection,
  type StockTransactionType,
} from "@prisma/client";
import { logger } from "../../config/logger.js";
import { prisma } from "../../database/prisma.js";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { isExpired } from "../../utils/date-time.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type StockMovementInput = {
  productId: string;
  batchId: string;
  locationId: string;
  transactionType: StockTransactionType;
  direction: StockDirection;
  /** Positive quantity expressed in the product's BASE unit. */
  quantity: Prisma.Decimal | number | string;
  referenceType?: string | null;
  referenceId?: string | null;
  notes?: string | null;
  actor: Pick<AuthenticatedUser, "id">;
};

export type StockMovementResult = {
  transaction: Prisma.StockTransactionGetPayload<Record<string, never>>;
  stock: {
    id: string;
    productId: string;
    batchId: string;
    locationId: string;
    quantity: Prisma.Decimal;
  };
};

const RETRYABLE_ERROR_CODES = new Set(["P2002", "P2034"]);
const MAX_ATTEMPTS = 3;

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    RETRYABLE_ERROR_CODES.has(error.code)
  );
}

/**
 * THE only approved way to change inventory quantities.
 *
 * Every movement:
 *   1. Runs inside a single interactive Prisma transaction.
 *   2. Serialises concurrent movements for the same (batch, location) with a
 *      PostgreSQL advisory transaction lock, so the row may be created while
 *      serialised (a plain SELECT ... FOR UPDATE cannot lock a row that does
 *      not exist yet, and would race two simultaneous OPENING movements).
 *   3. Re-validates the batch/product/location inside the transaction.
 *   4. Computes the new balance, guards against negative stock for OUT
 *      movements, updates InventoryStock and inserts the immutable
 *      StockTransaction row together (all-or-nothing).
 */
export const stockMovementService = {
  async recordMovement(input: StockMovementInput): Promise<StockMovementResult> {
    const rawQuantity = roundTo(toDecimal(input.quantity), 3);
    if (rawQuantity.lte(0)) {
      throw new AppError(
        422,
        ErrorCode.INVALID_STOCK_QUANTITY,
        "Quantity must be greater than zero",
      );
    }

    const quantity = rawQuantity;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        // A generous timeout is required on pooled/managed Postgres
        // connections (e.g. Neon), where a single round trip can take seconds.
        return await prisma.$transaction(
          async (tx) => {
          // Serialise writers for this exact stock record (product is implied
          // by the batch, which belongs to exactly one product).
          // $executeRaw is used because pg_advisory_xact_lock returns void,
          // which $queryRaw cannot deserialize.
          const lockKey = `stock:${input.batchId}:${input.locationId}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

          const batch = await tx.batch.findUnique({
            where: { id: input.batchId },
            select: { id: true, productId: true, expiryDate: true },
          });
          if (!batch) {
            throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
          }
          if (batch.productId !== input.productId) {
            throw new AppError(
              422,
              ErrorCode.BATCH_PRODUCT_MISMATCH,
              "The batch does not belong to the given product",
            );
          }
          if (input.direction === "IN" && isExpired(batch.expiryDate)) {
            throw new AppError(
              409,
              ErrorCode.EXPIRED_BATCH,
              "Cannot add stock to an expired batch",
            );
          }

          const location = await tx.inventoryLocation.findUnique({
            where: { id: input.locationId },
            select: { id: true, isActive: true },
          });
          if (!location) {
            throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
          }
          if (input.direction === "IN" && !location.isActive) {
            throw new AppError(
              409,
              ErrorCode.INACTIVE_LOCATION,
              "Inactive locations cannot receive stock",
            );
          }

          const existing = await tx.inventoryStock.findUnique({
            where: {
              batchId_locationId: {
                batchId: input.batchId,
                locationId: input.locationId,
              },
            },
          });

          let newBalance: Prisma.Decimal;
          let stockRow: {
            id: string;
            productId: string;
            batchId: string;
            locationId: string;
            quantity: Prisma.Decimal;
          };

          if (input.direction === "OUT") {
            if (!existing || existing.quantity.lessThan(quantity)) {
              throw new AppError(
                409,
                ErrorCode.INSUFFICIENT_STOCK,
                "Insufficient stock for this movement",
                { available: existing ? existing.quantity.toNumber() : 0 },
              );
            }
            newBalance = existing.quantity.minus(quantity);
            const updated = await tx.inventoryStock.update({
              where: { id: existing.id },
              data: { quantity: newBalance },
            });
            stockRow = {
              id: updated.id,
              productId: updated.productId,
              batchId: updated.batchId,
              locationId: updated.locationId,
              quantity: updated.quantity,
            };
          } else {
            const current = existing ? existing.quantity : new Prisma.Decimal(0);
            newBalance = current.plus(quantity);
            if (existing) {
              const updated = await tx.inventoryStock.update({
                where: { id: existing.id },
                data: { quantity: newBalance },
              });
              stockRow = {
                id: updated.id,
                productId: updated.productId,
                batchId: updated.batchId,
                locationId: updated.locationId,
                quantity: updated.quantity,
              };
            } else {
              const created = await tx.inventoryStock.create({
                data: {
                  productId: input.productId,
                  batchId: input.batchId,
                  locationId: input.locationId,
                  quantity: newBalance,
                },
              });
              stockRow = {
                id: created.id,
                productId: created.productId,
                batchId: created.batchId,
                locationId: created.locationId,
                quantity: created.quantity,
              };
            }
          }

          const transaction = await tx.stockTransaction.create({
            data: {
              productId: input.productId,
              batchId: input.batchId,
              locationId: input.locationId,
              transactionType: input.transactionType,
              direction: input.direction,
              quantity,
              balanceAfter: newBalance,
              referenceType: input.referenceType ?? null,
              referenceId: input.referenceId ?? null,
              notes: input.notes ?? null,
              createdById: input.actor.id,
            },
          });

          return {
            transaction,
            stock: stockRow,
          };
          },
          {
            maxWait: 10_000,
            timeout: 30_000,
          },
        );
      } catch (error) {
        if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
          logger.warn(
            { err: error, attempt, lockKey: `stock:${input.batchId}:${input.locationId}` },
            "Retrying stock movement after a transient database conflict",
          );
          continue;
        }
        throw error;
      }
    }

    // Unreachable: the loop returns or throws.
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, "Stock movement failed");
  },
};
