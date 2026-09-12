import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays, toUtcDay } from "../../../utils/date-time.js";
import { PageQuery } from "../../../utils/pagination.js";

type ProfitMarginReportQuery = {
  productGroupId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
};

function getDateRange(dateFrom?: Date, dateTo?: Date) {
  const end = dateTo ? toUtcDay(dateTo) : startOfTodayUtc();
  const start = dateFrom ? toUtcDay(dateFrom) : addUtcDays(startOfTodayUtc(), -30);
  return { start, end };
}

const getProfitMarginReportFn = async (query: {
  productGroupId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}) => {
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
      price: true,
      costPrice: true,
      productGroup: { select: { id: true, name: true, defaultProfitMargin: true } },
      genericProduct: { select: { id: true, name: true } },
      manufacturer: { select: { id: true, name: true } },
    },
  });

  let salesData: Map<string, { revenue: number; cost: number; quantity: number }> = new Map();
  if (query.dateFrom || query.dateTo) {
    const { start, end } = getDateRange(query.dateFrom, query.dateTo);
    const salesLines = await prisma.saleLine.findMany({
      where: {
        sale: {
          status: "COMPLETED",
          createdAt: { gte: start, lte: end },
        },
      },
      select: {
        productId: true,
        quantityBaseUnits: true,
        lineTotal: true,
        product: { select: { costPrice: true } },
      },
    });

    for (const line of salesLines) {
      const key = line.productId;
      const revenue = line.lineTotal.toNumber();
      const cost = line.product?.costPrice?.toNumber() ?? 0;
      const qty = line.quantityBaseUnits.toNumber();
      const existing = salesData.get(key) ?? { revenue: 0, cost: 0, quantity: 0 };
      existing.revenue += revenue;
      existing.cost += cost * qty;
      existing.quantity += qty;
      salesData.set(key, existing);
    }
  }

  const items: Array<{
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
  }> = [];

  for (const product of products) {
    const price = product.price?.toNumber() ?? 0;
    const cost = product.costPrice?.toNumber() ?? 0;
    const margin = price > 0 ? ((price - cost) / price) * 100 : 0;

    let actualMargin = margin;
    let revenue = 0;
    let cost = 0;
    let quantity = 0;

    if (query.dateFrom || query.dateTo) {
      const sales = salesData.get(product.id);
      if (sales) {
        revenue = sales.revenue;
        cost = sales.cost;
        quantity = sales.quantity;
        actualMargin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;
      }

      items.push({
        productGroupId: product.productGroup.id,
        productGroupName: product.productGroup.name,
        productGroupMargin: product.productGroup.defaultProfitMargin.toNumber(),
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        sellingPrice: price,
        costPrice: cost,
        targetMargin: margin,
        actualMargin,
        revenue,
        cost,
        quantitySold: quantity,
      });
    }

    let filteredItems = items;
    if (query.productGroupId) {
      filteredItems = items.filter((i) => i.productGroupId === query.productGroupId);
    }

    const paginatedItems = filteredItems.slice(skip, skip + take);
    return { items: paginatedItems, meta: buildPaginationMeta(filteredItems.length, page, limit) };
};

export const getProfitMarginReport = getProfitMarginReportFn;