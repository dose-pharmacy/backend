import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import {
  fetchProductSalesAggregates,
  fetchSalesTotals,
  resolveReportScope,
  safeRatio,
  type SalesTotals,
} from "./report-query.service.js";
import { compareNumbers, compareStrings, resolveSort } from "../../../utils/reporting/sort.js";
import type { PageQuery } from "../../../utils/pagination.js";
import type { ReportDateRangeInput } from "../../../utils/reporting/date-range.js";

export type ProfitabilityGroupBy =
  | "BRAND"
  | "MANUFACTURER"
  | "PRODUCT_GROUP"
  | "PRODUCT";

export type ProfitabilityReportQuery = PageQuery &
  ReportDateRangeInput & {
    groupBy?: ProfitabilityGroupBy;
    productGroupId?: string;
    manufacturerId?: string;
    sortBy?: string;
    sortOrder?: string;
  };

export type ProfitabilitySummaryQuery = ReportDateRangeInput & {
  groupBy?: ProfitabilityGroupBy;
  productGroupId?: string;
  manufacturerId?: string;
};

export const PROFITABILITY_SORT_FIELDS = [
  "profit",
  "revenue",
  "cost",
  "margin",
  "quantity",
  "productCount",
  "value",
] as const;
export type ProfitabilitySortField =
  (typeof PROFITABILITY_SORT_FIELDS)[number];

type ProfitabilityItem = {
  dimension: ProfitabilityGroupBy;
  value: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
  quantity: number;
  productCount: number;
};

function sortProfitabilityItems(
  items: ProfitabilityItem[],
  field: ProfitabilitySortField,
  order: "asc" | "desc",
): ProfitabilityItem[] {
  return [...items].sort((a, b) => {
    if (field === "value") {
      return compareStrings(a.value, b.value, order);
    }
    return compareNumbers(a[field], b[field], order);
  });
}

async function getProfitabilityReportFn(query: ProfitabilityReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const scope = resolveReportScope(query);
  const groupBy: ProfitabilityGroupBy = query.groupBy ?? "PRODUCT";

  const { field, order } = resolveSort(query, {
    allowed: PROFITABILITY_SORT_FIELDS,
    defaultField: "profit",
    defaultOrder: "desc",
  });

  // Per-product revenue/COGS/quantity, aggregated in PostgreSQL.
  const aggregates = await fetchProductSalesAggregates(scope);

  if (aggregates.length === 0) {
    return {
      items: [] as ProfitabilityItem[],
      meta: buildPaginationMeta(0, page, limit),
    };
  }

  // One lookup for all sold products; no per-product query.
  const products = await prisma.product.findMany({
    where: { id: { in: aggregates.map((row) => row.productId) } },
    select: {
      id: true,
      name: true,
      brand: true,
      manufacturer: { select: { id: true, name: true } },
      productGroup: { select: { id: true, name: true } },
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const groupKeyFn = (productId: string): string => {
    const product = productById.get(productId);
    switch (groupBy) {
      case "BRAND":
        return product?.brand ?? "Unknown Brand";
      case "MANUFACTURER":
        return product?.manufacturer?.name ?? "Unknown Manufacturer";
      case "PRODUCT_GROUP":
        return product?.productGroup?.name ?? "Unknown Group";
      case "PRODUCT":
      default:
        return product?.name ?? "Unknown product";
    }
  };

  const grouped = new Map<
    string,
    {
      key: string;
      revenue: number;
      cost: number;
      quantity: number;
      productIds: Set<string>;
    }
  >();

  for (const row of aggregates) {
    const key = groupKeyFn(row.productId);
    const existing =
      grouped.get(key) ??
      { key, revenue: 0, cost: 0, quantity: 0, productIds: new Set<string>() };
    existing.revenue += row.revenue;
    existing.cost += row.cost;
    existing.quantity += row.quantity;
    existing.productIds.add(row.productId);
    grouped.set(key, existing);
  }

  const allItems: ProfitabilityItem[] = Array.from(grouped.values()).map(
    (group) => {
      const profit = group.revenue - group.cost;
      return {
        dimension: groupBy,
        value: group.key,
        revenue: group.revenue,
        cost: group.cost,
        profit,
        margin: safeRatio(profit, group.revenue),
        quantity: group.quantity,
        productCount: group.productIds.size,
      };
    },
  );

  const sorted = sortProfitabilityItems(allItems, field, order);
  return {
    items: sorted.slice(skip, skip + take),
    meta: buildPaginationMeta(sorted.length, page, limit),
  };
}

/**
 * Whole-dataset profitability totals. Independent of pagination: the caller
 * never has to sum the current page to learn the real totals.
 */
async function getProfitabilitySummaryFn(
  query: ProfitabilitySummaryQuery,
): Promise<SalesTotals> {
  const scope = resolveReportScope(query);
  return fetchSalesTotals(scope);
}

export const getProfitabilityReport = getProfitabilityReportFn;
export const getProfitabilitySummary = getProfitabilitySummaryFn;
