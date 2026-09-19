import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import {
  compareNumbers,
  compareStrings,
  resolveSort,
} from "../../utils/reporting/sort.js";
import {
  fetchProductSalesAggregates,
  resolveReportScope,
  safeRatio,
} from "./reports/report-query.service.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { ReportDateRangeInput } from "../../utils/reporting/date-range.js";

import { getProfitabilityReport, getProfitabilitySummary } from "./reports/profitability-report.service.js";
import { getSlowMovingReport } from "./reports/slow-moving-report.service.js";
import {
  getSalesReport,
  getSalesSummary,
  getSalesDetail,
  getSalesTrend,
} from "./reports/sales-report.service.js";

export type ProfitMarginReportQuery = PageQuery &
  ReportDateRangeInput & {
    productGroupId?: string;
    sortBy?: string;
    sortOrder?: string;
  };

export type ProfitMarginSummaryQuery = ReportDateRangeInput & {
  productGroupId?: string;
};

export const PROFIT_MARGIN_SORT_FIELDS = [
  "productName",
  "actualMargin",
  "targetMargin",
  "revenue",
  "cost",
  "quantitySold",
  "sellingPrice",
] as const;
export type ProfitMarginSortField = (typeof PROFIT_MARGIN_SORT_FIELDS)[number];

type ProfitMarginItem = {
  productGroupId: string;
  productGroupName: string;
  productGroupMargin: number;
  productId: string;
  productName: string;
  sku: string;
  sellingPrice: number;
  costPrice: number;
  targetMargin: number;
  actualMargin: number;
  revenue: number;
  cost: number;
  quantitySold: number;
};

/** Rounds to 2 decimals, never emitting NaN/Infinity. */
function round2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

type MarginProductRow = {
  productId: string;
  productGroupId: string;
  productGroupName: string;
  productGroupMargin: number;
  productName: string;
  sku: string;
  sellingPrice: number;
  costPrice: number;
  targetMargin: number;
  actualMargin: number;
  revenue: number;
  cost: number;
  quantitySold: number;
};

/**
 * Loads every active product in scope with its configured target margin plus
 * its actual sales revenue/COGS for the period.
 *
 * Sale totals come from a single database-side aggregation; products with no
 * sales in the window are still returned with zero revenue.
 */
async function loadMarginProducts(scope: {
  start: Date;
  end: Date;
  productGroupId?: string;
}): Promise<MarginProductRow[]> {
  const [products, aggregates] = await Promise.all([
    prisma.product.findMany({
      where: {
        isActive: true,
        ...(scope.productGroupId ? { productGroupId: scope.productGroupId } : {}),
      },
      select: {
        id: true,
        name: true,
        sku: true,
        productGroup: {
          select: { id: true, name: true, defaultProfitMargin: true },
        },
        // Sell price + reference purchase price live on the base ProductUnit.
        units: {
          where: { isBaseUnit: true },
          select: { sellPrice: true, purchasePrice: true },
          take: 1,
        },
      },
    }),
    fetchProductSalesAggregates(scope),
  ]);

  const salesByProduct = new Map(
    aggregates.map((row) => [row.productId, row] as const),
  );

  return products.map((product) => {
    const baseUnit = product.units[0];
    const sellingPrice = baseUnit?.sellPrice?.toNumber() ?? 0;
    const referenceCost = baseUnit?.purchasePrice?.toNumber() ?? 0;

    // Target margin uses the configured reference cost. Guard against a zero
    // or missing sell price instead of dividing by zero.
    const targetMargin =
      sellingPrice > 0
        ? round2(((sellingPrice - referenceCost) / sellingPrice) * 100)
        : 0;

    const sales = salesByProduct.get(product.id);
    const revenue = sales?.revenue ?? 0;
    const cost = sales?.cost ?? 0;
    const quantitySold = sales?.quantity ?? 0;

    // Actual margin uses real batch cost when sales exist; falls back to the
    // target margin for products with no sales so a product is never reported
    // as "below target" purely because it did not sell.
    const actualMargin = revenue > 0 ? safeRatio(revenue - cost, revenue) : targetMargin;

    return {
      productId: product.id,
      productGroupId: product.productGroup.id,
      productGroupName: product.productGroup.name,
      productGroupMargin: product.productGroup.defaultProfitMargin.toNumber(),
      productName: product.name,
      sku: product.sku,
      sellingPrice,
      costPrice: referenceCost,
      targetMargin,
      actualMargin,
      revenue,
      cost,
      quantitySold,
    };
  });
}

function sortMarginItems(
  items: MarginProductRow[],
  field: ProfitMarginSortField,
  order: "asc" | "desc",
): MarginProductRow[] {
  return [...items].sort((a, b) => {
    if (field === "productName") {
      return compareStrings(a.productName, b.productName, order);
    }
    return compareNumbers(
      a[field as keyof MarginProductRow] as number,
      b[field as keyof MarginProductRow] as number,
      order,
    );
  });
}

async function getProfitMarginReport(query: ProfitMarginReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const scope = resolveReportScope(query);

  const { field, order } = resolveSort(query, {
    allowed: PROFIT_MARGIN_SORT_FIELDS,
    defaultField: "productName",
    defaultOrder: "asc",
  });

  const rows = await loadMarginProducts(scope);
  const sorted = sortMarginItems(rows, field, order);

  const items: ProfitMarginItem[] = sorted.slice(skip, skip + take);
  return { items, meta: buildPaginationMeta(sorted.length, page, limit) };
}

export type ProfitMarginSummary = {
  productCount: number;
  belowTargetCount: number;
  averageTargetMargin: number;
  averageActualMargin: number;
};

/**
 * Margin figures for the COMPLETE filtered dataset (never just one page).
 *
 * - Products with no sales in the window are included with `actualMargin`
 *   equal to their target margin, matching the per-product report.
 * - Averages are only taken over products that have a margin row, and every
 *   division is guarded, so the response never contains NaN or Infinity.
 */
async function getProfitMarginSummary(
  query: ProfitMarginSummaryQuery,
): Promise<ProfitMarginSummary> {
  const scope = resolveReportScope(query);
  const rows = await loadMarginProducts(scope);

  if (rows.length === 0) {
    return {
      productCount: 0,
      belowTargetCount: 0,
      averageTargetMargin: 0,
      averageActualMargin: 0,
    };
  }

  let belowTargetCount = 0;
  let targetSum = 0;
  let actualSum = 0;

  for (const row of rows) {
    targetSum += row.targetMargin;
    actualSum += row.actualMargin;
    if (row.actualMargin < row.targetMargin) {
      belowTargetCount += 1;
    }
  }

  return {
    productCount: rows.length,
    belowTargetCount,
    averageTargetMargin: round2(targetSum / rows.length),
    averageActualMargin: round2(actualSum / rows.length),
  };
}

export {
  getProfitabilityReport,
  getProfitabilitySummary,
  getProfitMarginReport,
  getProfitMarginSummary,
  getSlowMovingReport,
  getSalesReport,
  getSalesSummary,
  getSalesDetail,
  getSalesTrend,
};

export type { SalesTrendPoint } from "./reports/report-query.service.js";
export type { SalesTotals } from "./reports/report-query.service.js";

export type {
  ProfitabilityReportQuery,
  ProfitabilitySummaryQuery,
  ProfitabilityGroupBy,
} from "./reports/profitability-report.service.js";

export type { SlowMovingReportQuery } from "./reports/slow-moving-report.service.js";

export type {
  SalesReportQuery,
  SalesDetailQuery,
} from "./reports/sales-report.service.js";
