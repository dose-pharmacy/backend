import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { batchRepository } from "../../repositories/inventory/batch.repository.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { stockTransactionRepository } from "../../repositories/inventory/stock-transaction.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { addUtcDays, startOfTodayUtc, toUtcDay } from "../../utils/date-time.js";
import { toDecimal } from "../../utils/decimal.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateBatchInput = {
  productId: string;
  batchNumber: string;
  manufacturingDate?: Date;
  receivedDate?: Date;
  expiryDate: Date;
  purchaseCost?: number;
  supplierReference?: string;
};

export type UpdateBatchInput = Partial<{
  batchNumber: string;
  manufacturingDate: Date | null;
  receivedDate: Date | null;
  expiryDate: Date;
  purchaseCost: number | null;
  supplierReference: string | null;
}>;

export type BatchStatus = "AVAILABLE" | "LOW_STOCK" | "DEPLETED" | "EXPIRED";

export type ListBatchesQuery = PageQuery & {
  productId?: string;
  search?: string;
  locationId?: string;
  status?: BatchStatus;
  expiresBefore?: Date;
  expiresAfter?: Date;
};

export type BatchTransactionQuery = PageQuery & {
  transactionType?: string;
};

const MIN_EXPIRY_DATE = addUtcDays(startOfTodayUtc(), 1);

function assertExpiryValid(expiry: Date): void {
  if (toUtcDay(expiry).getTime() < MIN_EXPIRY_DATE.getTime()) {
    throw new AppError(
      422,
      ErrorCode.INVALID_EXPIRY_DATE,
      "Expiry date must be at least tomorrow",
    );
  }
}

function calculateBatchStatus(
  totalQuantity: number,
  expiryDate: Date,
): BatchStatus {
  const today = startOfTodayUtc();
  if (expiryDate < today) {
    return "EXPIRED";
  }
  if (totalQuantity <= 0) {
    return "DEPLETED";
  }
  // Could add LOW_STOCK threshold logic here if needed
  // For now, anything with stock is AVAILABLE
  return "AVAILABLE";
}

async function assertProductExists(productId: string): Promise<void> {
  const product = await productRepository.findById(productId);
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
}

export const batchService = {
  async list(query: ListBatchesQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await batchRepository.list({
      productId: query.productId,
      search: query.search,
      expiresBefore: query.expiresBefore,
      expiresAfter: query.expiresAfter,
      skip,
      take,
    });

    // Always enrich with stock data so every batch item has totalQuantity/status/daysUntilExpiry
    const batchIds = items.map((item) => item.id);
    const stockByBatch = batchIds.length
      ? await inventoryStockRepository.quantityByBatchAndLocation(batchIds, query.locationId)
      : [];
    const stockMap = new Map(stockByBatch.map((s) => [s.batchId, s.quantity]));

    const today = startOfTodayUtc();
    const enrichedItems = items
      .map((item) => {
        const totalQuantity = stockMap.get(item.id)?.toNumber() ?? 0;
        const status = calculateBatchStatus(totalQuantity, item.expiryDate);
        const daysUntilExpiry = Math.ceil(
          (item.expiryDate.getTime() - today.getTime()) / 86_400_000,
        );
        return { ...item, totalQuantity, status, daysUntilExpiry };
      })
      .filter((item) => {
        if (query.locationId && item.totalQuantity <= 0) return false;
        if (query.status && item.status !== query.status) return false;
        return true;
      });

    return { items: enrichedItems, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const batch = await batchRepository.findById(id);
    if (!batch) {
      throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
    }

    const [totalQuantity] = await Promise.all([
      inventoryStockRepository.batchTotalQuantity(id),
    ]);

    const today = startOfTodayUtc();
    const status = calculateBatchStatus(totalQuantity.toNumber(), batch.expiryDate);
    const daysUntilExpiry = Math.ceil(
      (batch.expiryDate.getTime() - today.getTime()) / 86_400_000,
    );

    // Resolve location names so the frontend doesn't need extra calls.
    // quantityByBatchAndLocation returns { batchId, quantity } — for a
    // per-location breakdown with names use a dedicated query.
    const locationRows = await inventoryStockRepository.quantityByLocation(batch.productId);

    return {
      ...batch,
      totalQuantity: totalQuantity.toNumber(),
      locationStock: locationRows,
      status,
      daysUntilExpiry,
    };
  },

  async getTransactions(batchId: string, query: BatchTransactionQuery) {
    const batch = await batchRepository.findById(batchId);
    if (!batch) {
      throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
    }

    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await stockTransactionRepository.listByBatch(batchId, {
      skip,
      take,
    });

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateBatchInput) {
    await assertProductExists(input.productId);

    const duplicate = await batchRepository.findByNumber(input.productId, input.batchNumber);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_BATCH, "A batch with this number already exists for the product");
    }

    const expiryDate = toUtcDay(input.expiryDate);
    assertExpiryValid(expiryDate);

    return batchRepository.create({
      productId: input.productId,
      batchNumber: input.batchNumber,
      manufacturingDate: input.manufacturingDate ? toUtcDay(input.manufacturingDate) : null,
      receivedDate: input.receivedDate ? toUtcDay(input.receivedDate) : null,
      expiryDate,
      purchaseCost: input.purchaseCost !== undefined ? toDecimal(input.purchaseCost) : null,
      supplierReference: input.supplierReference,
    });
  },

  async update(id: string, input: UpdateBatchInput) {
    const batch = await batchRepository.findById(id);
    if (!batch) {
      throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
    }

    if (
      input.batchNumber !== undefined &&
      input.batchNumber.toLowerCase() !== batch.batchNumber.toLowerCase()
    ) {
      const duplicate = await batchRepository.findByNumber(
        batch.productId,
        input.batchNumber,
        id,
      );
      if (duplicate) {
        throw new AppError(409, ErrorCode.DUPLICATE_BATCH, "A batch with this number already exists for the product");
      }
    }

    const expiryDate =
      input.expiryDate !== undefined ? toUtcDay(input.expiryDate) : undefined;
    if (expiryDate) {
      assertExpiryValid(expiryDate);
    }

    return batchRepository.update(id, {
      batchNumber: input.batchNumber,
      manufacturingDate:
        input.manufacturingDate !== undefined
          ? input.manufacturingDate === null
            ? null
            : toUtcDay(input.manufacturingDate)
          : undefined,
      receivedDate:
        input.receivedDate !== undefined
          ? input.receivedDate === null
            ? null
            : toUtcDay(input.receivedDate)
          : undefined,
      expiryDate,
      purchaseCost:
        input.purchaseCost !== undefined
          ? input.purchaseCost === null
            ? null
            : toDecimal(input.purchaseCost)
          : undefined,
      supplierReference: input.supplierReference,
    });
  },

  async remove(id: string) {
    const batch = await batchRepository.findById(id);
    if (!batch) {
      throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
    }

    const usages = await batchRepository.countUsages(id);
    if (usages.stock > 0 || usages.transactions > 0) {
      throw new AppError(
        409,
        ErrorCode.BATCH_IN_USE,
        "Cannot delete a batch that holds stock or has transaction history",
        usages,
      );
    }

    await batchRepository.deleteById(id);
  },
};
