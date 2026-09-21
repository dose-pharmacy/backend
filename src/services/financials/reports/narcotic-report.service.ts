import {
  Prisma,
  StockTransactionType,
} from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { AppError } from "../../../errors/app-error.js";
import { ErrorCode } from "../../../errors/error-codes.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import type { PageQuery } from "../../../utils/pagination.js";
import {
  resolveReportScope,
  toNumber,
  VALID_SALE_STATUS,
} from "./report-query.service.js";
import type { ReportDateRangeInput } from "../../../utils/reporting/date-range.js";

/**
 * ============================================================================
 * Narcotic Report
 * ============================================================================
 *
 * Narcotic/controlled-product reporting for the MVP. The single source of
 * truth for "is this a narcotic" is `Product.isNarcotic` (a plain boolean);
 * the database performs the filtering — rows are never fetched and filtered
 * in application memory.
 *
 * No new data model: the report reuses
 *
 *   Product -> Batch -> InventoryStock -> StockTransaction
 *
 * and the canonical sale lines (`SaleItem`, completed sales only, matching
 * `report-query.service.ts`). Sale quantities and stock-transaction
 * quantities are aggregated in SEPARATE groupBy queries and combined by
 * product id, so joining the one-to-many SaleItemBatch relation can never
 * multiply (double-count) sale quantities.
 *
 * Date semantics follow `resolveReportScope` (UTC start of `dateFrom` through
 * end-of-day of `dateTo`, inclusive), identical to every other report
 * endpoint in this codebase.
 */

export type NarcoticReportQuery = PageQuery &
  ReportDateRangeInput & {
    search?: string;
    productId?: string;
    locationId?: string;
  };

export type NarcoticActivityQuery = PageQuery &
  ReportDateRangeInput & {
    productId?: string;
    locationId?: string;
    batchId?: string;
    movementType?: StockTransactionType;
  };

export type NarcoticSummaryItem = {
  productId: string;
  productName: string;
  sku: string;
  genericName: string | null;
  brand: string | null;
  isNarcotic: boolean;
  batches: Array<{
    batchId: string;
    batchNumber: string;
    expiryDate: Date;
    locationId: string;
    locationName: string;
    currentQuantity: number;
  }>;
  soldQuantity?: number;
  purchasedQuantity?: number;
  returnedQuantity?: number;
  adjustedQuantity?: number;
};

export type NarcoticActivityItem = {
  transactionId: string;
  date: Date;
  productId: string;
  productName: string;
  sku: string;
  batchId: string;
  batchNumber: string;
  expiryDate: Date;
  locationId: string;
  locationName: string;
  movementType: StockTransactionType;
  direction: "IN" | "OUT";
  quantity: number;
  balanceAfter: number;
  reference: string | null;
};

/** Product-level filters shared by the summary and activity endpoints. */
function productWhere(query: {
  search?: string;
  productId?: string;
}): Prisma.ProductWhereInput {
  return {
    isNarcotic: true,
    ...(query.productId ? { id: query.productId } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" as const } },
            { genericName: { contains: query.search, mode: "insensitive" as const } },
            { brand: { contains: query.search, mode: "insensitive" as const } },
            { sku: { contains: query.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

/** Aggregated sale quantities per product, completed sales only. */
async function fetchSaleAggregates(
  scope: { start: Date; end: Date; locationId?: string },
  productIds: string[],
): Promise<Map<string, number>> {
  const rows = await prisma.saleItem.groupBy({
    by: ["productId"],
    where: {
      productId: { in: productIds },
      sale: {
        status: VALID_SALE_STATUS,
        createdAt: { gte: scope.start, lte: scope.end },
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    },
    _sum: { baseQuantity: true },
  });
  return new Map(rows.map((row) => [row.productId, toNumber(row._sum.baseQuantity)]));
}

/**
 * Aggregated stock-transaction quantities per product for the given movement
 * types, signed by direction (IN adds, OUT subtracts). Kept separate from the
 * sale aggregation so no one-to-many join can double-count.
 */
async function fetchStockAggregates(
  scope: { start: Date; end: Date; locationId?: string },
  productIds: string[],
  movementTypes: StockTransactionType[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) {
    return new Map();
  }
  const rows = await prisma.stockTransaction.groupBy({
    by: ["productId", "direction"],
    where: {
      productId: { in: productIds },
      transactionType: { in: movementTypes },
      createdAt: { gte: scope.start, lte: scope.end },
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    },
    _sum: { quantity: true },
  });

  const totals = new Map<string, number>();
  for (const row of rows) {
    const signed = row.direction === "IN" ? 1 : -1;
    totals.set(
      row.productId,
      (totals.get(row.productId) ?? 0) + signed * toNumber(row._sum.quantity),
    );
  }
  return totals;
}

export const narcoticReportService = {
  /**
   * Paginated narcotic product summary: identity + current batch/location
   * stock (read straight from the authoritative InventoryStock rows, expired
   * batches included so narcotics under expiry/disposal remain traceable) +
   * period activity quantities. Metrics with no activity in the window are
   * omitted instead of being reported as meaningless zeros.
   */
  async getNarcoticReport(query: NarcoticReportQuery): Promise<{
    items: NarcoticSummaryItem[];
    meta: ReturnType<typeof buildPaginationMeta>;
  }> {
    const { page, limit, skip, take } = resolvePagination(query);
    const scope = resolveReportScope(query);

    const where = productWhere(query);

    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          sku: true,
          genericName: true,
          brand: true,
          isNarcotic: true,
        },
        orderBy: { name: "asc" },
        skip,
        take,
      }),
      prisma.product.count({ where }),
    ]);

    if (products.length === 0) {
      return { items: [], meta: buildPaginationMeta(total, page, limit) };
    }

    const productIds = products.map((product) => product.id);

    const [batchStock, sales, purchases, saleReturns, adjustments] = await Promise.all([
      // Current stock straight from InventoryStock (already reflects sales,
      // adjustments, returns, expiry actions and transfers). Available =
      // quantity - reservedQuantity, the same convention as POS.
      prisma.inventoryStock.findMany({
        where: {
          productId: { in: productIds },
          quantity: { gt: 0 },
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
        select: {
          productId: true,
          batchId: true,
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          locationId: true,
          location: { select: { id: true, name: true } },
          quantity: true,
          reservedQuantity: true,
        },
        orderBy: [{ batch: { expiryDate: "asc" } }, { locationId: "asc" }],
      }),
      fetchSaleAggregates(scope, productIds),
      // Purchases include OPENING so initial narcotic stock shows up too.
      fetchStockAggregates(scope, productIds, ["PURCHASE", "OPENING"]),
      // RETURN_IN on a completed sale = customer return of narcotics.
      fetchStockAggregates(scope, productIds, ["RETURN_IN"]),
      fetchStockAggregates(scope, productIds, ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"]),
    ]);

    const batchStockByProduct = new Map<string, Array<{
      batchId: string;
      batchNumber: string;
      expiryDate: Date;
      locationId: string;
      locationName: string;
      currentQuantity: number;
    }>>();
    for (const stock of batchStock) {
      const available = stock.quantity.minus(stock.reservedQuantity);
      if (available.lte(0)) {
        continue;
      }
      const list = batchStockByProduct.get(stock.productId) ?? [];
      list.push({
        batchId: stock.batchId,
        batchNumber: stock.batch.batchNumber,
        expiryDate: stock.batch.expiryDate,
        locationId: stock.locationId,
        locationName: stock.location.name,
        currentQuantity: available.toNumber(),
      });
      batchStockByProduct.set(stock.productId, list);
    }

    const items: NarcoticSummaryItem[] = products.map((product) => {
      const sold = sales.get(product.id);
      const purchased = purchases.get(product.id);
      const returned = saleReturns.get(product.id);
      const adjusted = adjustments.get(product.id);

      return {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        genericName: product.genericName,
        brand: product.brand,
        isNarcotic: product.isNarcotic,
        batches: batchStockByProduct.get(product.id) ?? [],
        // Only include metrics that actually have activity in the window.
        ...(sold !== undefined ? { soldQuantity: sold } : {}),
        ...(purchased !== undefined ? { purchasedQuantity: purchased } : {}),
        ...(returned !== undefined ? { returnedQuantity: returned } : {}),
        ...(adjusted !== undefined ? { adjustedQuantity: adjusted } : {}),
      };
    });

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /**
   * Paginated movement-level activity for narcotic products, read straight
   * from the immutable StockTransaction ledger. Rows are the source of
   * truth; no aggregation is performed here.
   */
  async getNarcoticActivity(query: NarcoticActivityQuery): Promise<{
    items: NarcoticActivityItem[];
    meta: ReturnType<typeof buildPaginationMeta>;
  }> {
    const { page, limit, skip, take } = resolvePagination(query);
    const scope = resolveReportScope(query);

    // Validate movementType against the existing enum when supplied.
    if (query.movementType && !Object.values(StockTransactionType).includes(query.movementType)) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, "Invalid movement type");
    }

    const where: Prisma.StockTransactionWhereInput = {
      product: productWhere(query),
      createdAt: { gte: scope.start, lte: scope.end },
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.movementType ? { transactionType: query.movementType } : {}),
    };

    const [transactions, total] = await prisma.$transaction([
      prisma.stockTransaction.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          transactionType: true,
          direction: true,
          quantity: true,
          balanceAfter: true,
          referenceType: true,
          referenceId: true,
          product: { select: { id: true, name: true, sku: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
          location: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      prisma.stockTransaction.count({ where }),
    ]);

    const items: NarcoticActivityItem[] = transactions.map((tx) => ({
      transactionId: tx.id,
      date: tx.createdAt,
      productId: tx.product.id,
      productName: tx.product.name,
      sku: tx.product.sku,
      batchId: tx.batch.id,
      batchNumber: tx.batch.batchNumber,
      expiryDate: tx.batch.expiryDate,
      locationId: tx.location.id,
      locationName: tx.location.name,
      movementType: tx.transactionType,
      direction: tx.direction,
      quantity: toNumber(tx.quantity),
      balanceAfter: toNumber(tx.balanceAfter),
      reference:
        tx.referenceType && tx.referenceId
          ? `${tx.referenceType}:${tx.referenceId}`
          : null,
    }));

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};
