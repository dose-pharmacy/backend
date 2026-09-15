import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays, toUtcDay } from "../../utils/date-time.js";

import { getProfitabilityReport } from "./reports/profitability-report.service.js";
import { getSlowMovingReport } from "./reports/slow-moving-report.service.js";
import { getSalesReport, getSalesSummary, getSalesDetail } from "./reports/sales-report.service.js";

export type ProfitMarginReportQuery = {
  productGroupId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
};

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

function getDateRange(dateFrom?: Date, dateTo?: Date): { start: Date; end: Date } {
  const end = dateTo ? toUtcDay(dateTo) : startOfTodayUtc();
  const start = dateFrom ? toUtcDay(dateFrom) : addUtcDays(startOfTodayUtc(), -30);
  return { start, end };
}

export async function getProfitMarginReport(query: ProfitMarginReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);

  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      ...(query.productGroupId ? { productGroupId: query.productGroupId } : {}),
    },
    select: {
      id: true,
      name: true,
      sku: true,
      productGroup: { select: { id: true, name: true, defaultProfitMargin: true } },
      // Sell price + reference purchase price live on the base ProductUnit.
      units: {
        where: { isBaseUnit: true },
        select: { sellPrice: true, purchasePrice: true },
        take: 1,
      },
    },
  });

  // Aggregate revenue and true batch-level COGS per product.
  const salesData = new Map<string, { revenue: number; cost: number; quantity: number }>();

  const useDateFilter = Boolean(query.dateFrom || query.dateTo);

  if (useDateFilter) {
    const { start, end } = getDateRange(query.dateFrom, query.dateTo);

    const saleItems = await prisma.saleItem.findMany({
      where: {
        sale: {
          status: "COMPLETED",
          createdAt: { gte: start, lte: end },
        },
      },
      select: {
        productId: true,
        baseQuantity: true,
        lineTotal: true,
        batchAllocations: {
          select: {
            baseQuantity: true,
            batch: { select: { purchaseCost: true } },
          },
        },
      },
    });

    for (const item of saleItems) {
      const key = item.productId;
      const revenue = item.lineTotal.toNumber();
      const qty = item.baseQuantity.toNumber();

      let cost = 0;
      for (const alloc of item.batchAllocations) {
        const allocQty = alloc.baseQuantity.toNumber();
        const batchCost = alloc.batch.purchaseCost?.toNumber() ?? 0;
        cost += batchCost * allocQty;
      }

      const existing = salesData.get(key) ?? { revenue: 0, cost: 0, quantity: 0 };
      existing.revenue += revenue;
      existing.cost += cost;
      existing.quantity += qty;
      salesData.set(key, existing);
    }
  }

  const items: ProfitMarginItem[] = products.map((product) => {
    const baseUnit = product.units[0];
    const sellingPrice = baseUnit?.sellPrice?.toNumber() ?? 0;
    const referenceCost = baseUnit?.purchasePrice?.toNumber() ?? 0;

    // Target margin uses the configured reference cost.
    const targetMargin =
      sellingPrice > 0 ? ((sellingPrice - referenceCost) / sellingPrice) * 100 : 0;

    const sales = salesData.get(product.id);
    const revenue = sales?.revenue ?? 0;
    const cost = sales?.cost ?? 0;
    const quantitySold = sales?.quantity ?? 0;

    // Actual margin uses real batch cost when sales exist; falls back to target.
    const actualMargin =
      revenue > 0 ? ((revenue - cost) / revenue) * 100 : targetMargin;

    return {
      productGroupId: product.productGroup.id,
      productGroupName: product.productGroup.name,
      productGroupMargin: product.productGroup.defaultProfitMargin.toNumber(),
      productId: product.id,
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

  const paginatedItems = items.slice(skip, skip + take);

  return {
    items: paginatedItems,
    meta: buildPaginationMeta(items.length, page, limit),
  };
}

export { getProfitabilityReport, getSlowMovingReport, getSalesReport, getSalesSummary, getSalesDetail };

export type {
  ProfitabilityReportQuery,
} from "./reports/profitability-report.service.js";

export type {
  SlowMovingReportQuery,
} from "./reports/slow-moving-report.service.js";

export type {
  SalesReportQuery,
  SalesDetailQuery,
} from "./reports/sales-report.service.js";