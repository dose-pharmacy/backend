import { StockDirection, StockTransactionType } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { batchRepository } from "../../repositories/inventory/batch.repository.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { stockTransactionRepository } from "../../repositories/inventory/stock-transaction.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import type { PageQuery } from "../../utils/pagination.js";
import { productUnitService } from "./product-unit.service.js";
import { stockMovementService } from "./stock-movement.service.js";

export type OpeningStockInput = {
  productId: string;
  batchId: string;
  locationId: string;
  /** Quantity expressed in the unit identified by `unitId`. */
  quantity: number;
  unitId: string;
  notes?: string;
};

export type StockAdjustmentInput = {
  productId: string;
  batchId: string;
  locationId: string;
  direction: StockDirection;
  quantity: number;
  unitId: string;
  reason: string;
};

export type ListStockQuery = PageQuery & {
  productId?: string;
  batchId?: string;
  locationId?: string;
  search?: string;
};

function validateBatchProduct(batchId: string, productId: string): Promise<void> {
  return batchRepository.findById(batchId).then((batch) => {
    if (!batch) {
      throw new AppError(404, ErrorCode.BATCH_NOT_FOUND, "Batch not found");
    }
    if (batch.productId !== productId) {
      throw new AppError(
        422,
        ErrorCode.BATCH_PRODUCT_MISMATCH,
        "The batch does not belong to the given product",
      );
    }
  });
}

async function assertProductExists(productId: string): Promise<void> {
  const product = await productRepository.findById(productId);
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
}

export const stockService = {
  /**
   * Opening stock for a product batch at a location. Goes through the central
   * movement service so an OPENING / IN StockTransaction is always recorded.
   */
  async openingStock(input: OpeningStockInput, actor: Pick<AuthenticatedUser, "id">) {
    await validateBatchProduct(input.batchId, input.productId);
    const { baseQuantity } = await productUnitService.toBaseQuantity(
      input.productId,
      input.unitId,
      input.quantity,
    );

    return stockMovementService.recordMovement({
      productId: input.productId,
      batchId: input.batchId,
      locationId: input.locationId,
      transactionType: StockTransactionType.OPENING,
      direction: StockDirection.IN,
      quantity: baseQuantity,
      notes: input.notes,
      actor,
    });
  },

  /**
   * Manual stock adjustment (count corrections etc). The reason is mandatory
   * and is stored on the immutable StockTransaction.
   */
  async adjustment(input: StockAdjustmentInput, actor: Pick<AuthenticatedUser, "id">) {
    await validateBatchProduct(input.batchId, input.productId);
    const { baseQuantity } = await productUnitService.toBaseQuantity(
      input.productId,
      input.unitId,
      input.quantity,
    );

    const transactionType =
      input.direction === StockDirection.IN
        ? StockTransactionType.ADJUSTMENT_IN
        : StockTransactionType.ADJUSTMENT_OUT;

    return stockMovementService.recordMovement({
      productId: input.productId,
      batchId: input.batchId,
      locationId: input.locationId,
      transactionType,
      direction: input.direction,
      quantity: baseQuantity,
      notes: input.reason,
      actor,
    });
  },

  /** Current stock across products/batches/locations. */
  async listStock(query: ListStockQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await inventoryStockRepository.list({
      productId: query.productId,
      batchId: query.batchId,
      locationId: query.locationId,
      search: query.search,
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /** Stock rows for one product (dashboard/list support). */
  async listProductStock(productId: string, query: PageQuery) {
    await assertProductExists(productId);
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await inventoryStockRepository.list({
      productId,
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /** Paginated immutable transaction history for one product. */
  async listProductTransactions(productId: string, query: PageQuery) {
    await assertProductExists(productId);
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await stockTransactionRepository.listByProduct(productId, {
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};
