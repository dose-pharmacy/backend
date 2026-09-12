import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays, toUtcDay } from "../../../utils/date-time.js";
import type { PageQuery } from "../../../utils/pagination.js";

export type SalesReportQuery = PageQuery & {
  period?: "DAILY" | "MONTHLY" | "ANNUAL";
  dateFrom?: Date;
  dateTo?: Date;
  productGroupId?: string;
  manufacturerId?: string;
  locationId?: string;
};

export type SalesDetailQuery = PageQuery & {
  saleId?: string;
  productId?: string;
  cashierId?: string;
  locationId?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

function getDateRange(dateFrom?: Date, dateTo?: Date) {
  const end = dateTo ? toUtcDay(dateTo) : startOfTodayUtc();
  const start = dateFrom ? toUtcDay(dateFrom) : addUtcDays(startOfTodayUtc(), -30);
  return { start, end };
}

async function getSalesReportFn(query: SalesReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const { start, end } = getDateRange(query.dateFrom, query.dateTo);

  const where: Prisma.SaleWhereInput = {
    status: "COMPLETED",
    createdAt: { gte: start, lte: end },
    ...(query.locationId ? { locationId: query.locationId } : {}),
  };

  // Get sales with lines for detailed breakdown
  const sales = await prisma.sale.findMany({
    where,
    include: {
      lines: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              productGroup: { select: { id: true, name: true } },
              manufacturer: { select: { id: true, name: true } },
            },
          },
        },
      payments: true,
      location: { select: { id: true, name: true } },
      cashier: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    skip,
    take,
  });

  const total = await prisma.sale.count({ where });

  return { items: sales, meta: buildPaginationMeta(total, page, limit) };
}

async function getSalesSummaryFn(query: SalesReportQuery) {
  const { start, end } = getDateRange(query.dateFrom, query.dateTo);

  const where: Prisma.SaleWhereInput = {
    status: "COMPLETED",
    createdAt: { gte: start, lte: end },
    ...(query.locationId ? { locationId: query.locationId } : {}),
  };

  const [salesAgg, paymentAgg, topProducts] = await prisma.$transaction([
    prisma.sale.aggregate({
      where,
      _sum: { totalAmount: true, subtotal: true, billDiscountAmount: true },
      _count: true,
    }),
    prisma.payment.groupBy({
      by: ["method"],
      where: {
        sale: { status: "COMPLETED", createdAt: { gte: start, lte: end } },
      },
      _sum: { amount: true },
      orderBy: { method: "asc" },
    }),
    prisma.saleLine.findMany({
      where: { sale: { status: "COMPLETED", createdAt: { gte: start, lte: end } } },
      select: {
        productId: true,
        quantityBaseUnits: true,
        lineTotal: true,
        product: { select: { id: true, name: true, sku: true } },
      },
    }),
  ]);

  // Top products by revenue
  const productRevenue = new Map<string, { name: string; sku: string; revenue: number; quantity: number }>();
  for (const line of topProducts) {
    const key = line.productId;
    const rev = line.lineTotal.toNumber();
    const qty = line.quantityBaseUnits.toNumber();
    const existing = productRevenue.get(key) ?? { name: line.product.name, sku: line.product.sku, revenue: 0, quantity: 0 };
    existing.revenue += rev;
    existing.quantity += qty;
    productRevenue.set(key, existing);
  }

  const topProductsList = Array.from(productRevenue.entries())
    .map(([id, data]) => ({ productId: id, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    totalSales: salesAgg._sum.totalAmount?.toNumber() ?? 0,
    totalSubtotal: salesAgg._sum.subtotal?.toNumber() ?? 0,
    totalDiscount: salesAgg._sum.billDiscountAmount?.toNumber() ?? 0,
    transactionCount: salesAgg._count ?? 0,
    averageTransaction: salesAgg._count ? (salesAgg._sum.totalAmount?.toNumber() ?? 0) / salesAgg._count : 0,
    paymentsByMethod: paymentAgg.map((p) => ({
      method: p.method,
      amount: p._sum.amount?.toNumber() ?? 0,
    }),
    topProducts: topProductsList,
  };
}

async function getSalesDetailFn(query: SalesDetailQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const { start, end } = getDateRange(query.dateFrom, query.dateTo);

  const where: Prisma.SaleLineWhereInput = {
    sale: {
      status: "COMPLETED",
      createdAt: { gte: start, lte: end },
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.cashierId ? { cashierId: query.cashierId } : {}),
    },
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.saleId ? { saleId: query.saleId } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.saleLine.findMany({
      where,
      include: {
        sale: {
          select: {
            id: true,
            saleNumber: true,
            createdAt: true,
            location: { select: { id: true, name: true } },
            cashier: { select: { id: true, name: true } },
          },
        },
        product: {
          select: { id: true, name: true, sku: true, productGroup: { select: { id: true, name: true } } },
        },
      orderBy: { sale: { createdAt: "desc" } },
      skip,
      take,
    }),
    prisma.saleLine.count({ where }),
  ]);

  return { items, meta: buildPaginationMeta(total, page, limit) };
}

export const getSalesReport = getSalesReportFn;
export const getSalesSummary = getSalesSummaryFn;
export const getSalesDetail = getSalesDetailFn;