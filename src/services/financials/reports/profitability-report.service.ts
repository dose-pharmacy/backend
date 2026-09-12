import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays, toUtcDay } from "../../../utils/date-time.js";
import type { PageQuery } from "../../../utils/pagination.js";

export type ProfitabilityReportQuery = PageQuery & {
  groupBy?: "BRAND" | "MANUFACTURER" | "PRODUCT_GROUP" | "PRODUCT";
  productGroupId?: string;
  manufacturerId?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

function getDateRange(dateFrom?: Date, dateTo?: Date) {
  const end = dateTo ? toUtcDay(dateTo) : startOfTodayUtc();
  const start = dateFrom ? toUtcDay(dateFrom) : addUtcDays(startOfTodayUtc(), -30);
  return { start, end };
}

async function getProfitabilityReportFn(query: ProfitabilityReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const { start, end } = getDateRange(query.dateFrom, query.dateTo);

  const where: Prisma.SaleLineWhereInput = {
    sale: {
      status: "COMPLETED",
      createdAt: { gte: start, lte: end },
    },
    ...(query.productGroupId
      ? { product: { productGroupId: query.productGroupId } }
      : {}),
    ...(query.manufacturerId
      ? { product: { manufacturerId: query.manufacturerId } }
      : {}),
  };

  const lines = await prisma.saleLine.findMany({
    where,
    select: {
      productId: true,
      quantityBaseUnits: true,
      lineTotal: true,
      itemDiscountAmount: true,
      unitPrice: true,
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          brand: true,
          genericProduct: { select: { id: true, name: true } },
          manufacturer: { select: { id: true, name: true } },
          productGroup: { select: { id: true, name: true } },
          costPrice: true,
        },
      },
    },
  );

  // Group by selected dimension
  const groupKeyFn = (line: typeof lines[0]) => {
    switch (query.groupBy) {
      case "BRAND":
        return line.product.brand ?? "Unknown Brand";
      case "MANUFACTURER":
        return line.product.manufacturer?.name ?? "Unknown Manufacturer";
      case "PRODUCT_GROUP":
        return line.product.productGroup?.name ?? "Unknown Group";
      case "PRODUCT":
      default:
        return line.product.name;
    }
  };

  const groups = new Map<string, {
    key: string;
    revenue: number;
    cost: number;
    quantity: number;
    productCount: Set<string>;
  }>();

  for (const line of lines) {
    const key = groupKeyFn(line);
    const revenue = line.lineTotal.toNumber();
    const cost = line.product.costPrice?.toNumber() ?? 0;
    const qty = line.quantityBaseUnits.toNumber();
    const existing = groups.get(key) ?? { key, revenue: 0, cost: 0, quantity: 0, productCount: new Set() };
    existing.revenue += revenue;
    existing.cost += cost * qty;
    existing.quantity += qty;
    existing.productCount.add(line.productId);
    groups.set(key, existing);
  }

  const items = Array.from(groups.values()).map((g) => ({
    dimension: query.groupBy ?? "PRODUCT",
    value: g.key,
    revenue: g.revenue,
    cost: g.cost,
    profit: g.revenue - g.cost,
    margin: g.revenue > 0 ? ((g.revenue - g.cost) / g.revenue) * 100 : 0,
    quantity: g.quantity,
    productCount: g.productCount.size,
  });

  items.sort((a, b) => b.profit - a.profit);
  const paginatedItems = items.slice(skip, skip + take);
  return { items: paginatedItems, meta: buildPaginationMeta(items.length, page, limit) };
}

export const getProfitabilityReport = getProfitabilityReportFn;