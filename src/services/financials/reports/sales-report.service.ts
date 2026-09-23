import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import {
  fetchPaymentTotalsByMethod,
  resolveReportScope,
  validSaleItemWhere,
  validSaleWhere,
  VALID_SALE_STATUS,
} from "./report-query.service.js";
import { resolveSort, type SortOrder } from "../../../utils/reporting/sort.js";
import type { PageQuery } from "../../../utils/pagination.js";
import type { ReportDateRangeInput } from "../../../utils/reporting/date-range.js";

export type SalesReportQuery = PageQuery &
  ReportDateRangeInput & {
    locationId?: string;
    sortBy?: string;
    sortOrder?: string;
  };

export type SalesDetailQuery = PageQuery &
  ReportDateRangeInput & {
    saleId?: string;
    productId?: string;
    cashierId?: string;
    locationId?: string;
    sortBy?: string;
    sortOrder?: string;
  };

export const SALES_SORT_FIELDS = [
  "createdAt",
  "saleNumber",
  "totalAmount",
  "paidAmount",
] as const;
export type SalesSortField = (typeof SALES_SORT_FIELDS)[number];

export const SALES_DETAIL_SORT_FIELDS = [
  "createdAt",
  "lineTotal",
  "baseQuantity",
] as const;
export type SalesDetailSortField = (typeof SALES_DETAIL_SORT_FIELDS)[number];

/** Explicit mapping keeps caller input out of any query expression. */
function buildSaleOrderBy(
  field: SalesSortField,
  order: SortOrder,
): Prisma.SaleOrderByWithRelationInput {
  switch (field) {
    case "saleNumber":
      return { saleNumber: order };
    case "totalAmount":
      return { totalAmount: order };
    case "paidAmount":
      return { paidAmount: order };
    case "createdAt":
    default:
      return { createdAt: order };
  }
}

function buildSaleItemOrderBy(
  field: SalesDetailSortField,
  order: SortOrder,
): Prisma.SaleItemOrderByWithRelationInput {
  switch (field) {
    case "lineTotal":
      return { lineTotal: order };
    case "baseQuantity":
      return { baseQuantity: order };
    case "createdAt":
    default:
      return { sale: { createdAt: order } };
  }
}

/** Canonical sale-line shape (`SaleItem`) reused by the list and detail views. */
const saleItemInclude = {
  product: {
    select: {
      id: true,
      name: true,
      sku: true,
      productGroup: { select: { id: true, name: true } },
      manufacturer: { select: { id: true, name: true } },
    },
  },
  unit: { select: { id: true, name: true, symbol: true } },
} satisfies Prisma.SaleItemInclude;

async function getSalesReportFn(query: SalesReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const where = validSaleWhere(resolveReportScope(query));

  const { field, order } = resolveSort(query, {
    allowed: SALES_SORT_FIELDS,
    defaultField: "createdAt",
    defaultOrder: "desc",
  });

  const [sales, total] = await prisma.$transaction([
    prisma.sale.findMany({
      where,
      include: {
        items: { include: saleItemInclude },
        payments: true,
        location: { select: { id: true, name: true } },
        cashier: { select: { id: true, name: true } },
      },
      orderBy: buildSaleOrderBy(field, order),
      skip,
      take,
    }),
    prisma.sale.count({ where }),
  ]);

  return { items: sales, meta: buildPaginationMeta(total, page, limit) };
}

async function getSalesSummaryFn(
  query: ReportDateRangeInput & { locationId?: string },
) {
  const scope = resolveReportScope(query);

  const [salesAgg, paymentsByMethod, topGroups] = await Promise.all([
    prisma.sale.aggregate({
      where: validSaleWhere(scope),
      _sum: { totalAmount: true, subtotal: true, totalDiscount: true },
      _count: true,
    }),
    fetchPaymentTotalsByMethod(scope),
    // Aggregated per product in the database; only the top 10 groups return.
    prisma.saleItem.groupBy({
      by: ["productId"],
      where: validSaleItemWhere(scope),
      _sum: { lineTotal: true, baseQuantity: true },
      orderBy: { _sum: { lineTotal: "desc" } },
      take: 10,
    }),
  ]);

  const productIds = topGroups.map((group) => group.productId);
  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, sku: true },
      })
    : [];
  const productById = new Map(products.map((product) => [product.id, product]));

  const topProducts = topGroups.map((group) => {
    const product = productById.get(group.productId);
    return {
      productId: group.productId,
      name: product?.name ?? "Unknown product",
      sku: product?.sku ?? "",
      revenue: group._sum.lineTotal?.toNumber() ?? 0,
      quantity: group._sum.baseQuantity?.toNumber() ?? 0,
    };
  });

  const totalAmount = salesAgg._sum.totalAmount?.toNumber() ?? 0;
  const transactionCount = salesAgg._count ?? 0;

  return {
    totalSales: totalAmount,
    totalSubtotal: salesAgg._sum.subtotal?.toNumber() ?? 0,
    totalDiscount: salesAgg._sum.totalDiscount?.toNumber() ?? 0,
    transactionCount,
    averageTransaction: transactionCount ? totalAmount / transactionCount : 0,
    paymentsByMethod,
    topProducts,
  };
}

async function getSalesDetailFn(query: SalesDetailQuery) {
  const { page, limit, skip, take } = resolvePagination(query);
  const scope = resolveReportScope(query);

  const where: Prisma.SaleItemWhereInput = {
    sale: {
      status: VALID_SALE_STATUS,
      createdAt: { gte: scope.start, lte: scope.end },
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.cashierId ? { cashierId: query.cashierId } : {}),
    },
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.saleId ? { saleId: query.saleId } : {}),
  };

  const { field, order } = resolveSort(query, {
    allowed: SALES_DETAIL_SORT_FIELDS,
    defaultField: "createdAt",
    defaultOrder: "desc",
  });

  const [rows, total] = await prisma.$transaction([
    prisma.saleItem.findMany({
      where,
      include: {
        sale: {
          select: {
            id: true,
            saleNumber: true,
            status: true,
            subtotal: true,
            totalAmount: true,
            paidAmount: true,
            completedAt: true,
            createdAt: true,
            location: { select: { id: true, name: true } },
            cashier: { select: { id: true, name: true } },
          },
        },
        ...saleItemInclude,
      },
      orderBy: buildSaleItemOrderBy(field, order),
      skip,
      take,
    }),
    prisma.saleItem.count({ where }),
  ]);

  const items = rows.map((item) => ({
    ...item,
    quantity: item.quantity?.toNumber() ?? 0,
    baseQuantity: item.baseQuantity?.toNumber() ?? 0,
    lineTotal: item.lineTotal?.toNumber() ?? 0,
  }));

  return { items, meta: buildPaginationMeta(total, page, limit) };
}

export const getSalesReport = getSalesReportFn;
export const getSalesSummary = getSalesSummaryFn;
export const getSalesDetail = getSalesDetailFn;
export { getSalesTrend } from "./report-query.service.js";
export type { SalesTrendPoint } from "./report-query.service.js";
