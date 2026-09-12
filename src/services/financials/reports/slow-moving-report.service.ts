import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays } from "../../../utils/date-time.js";
import type { PageQuery } from "../../../utils/pagination.js";

export type SlowMovingReportQuery = PageQuery & {
  productGroupId?: string;
  manufacturerId?: string;
  isFlagged?: boolean;
  definitionType?: "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM";
};

function getThresholdDays(definitionType: string, customDays?: number | null): number {
  switch (definitionType) {
    case "DAYS_30":
      return 30;
    case "DAYS_60":
      return 60;
    case "DAYS_90":
      return 90;
    case "DAYS_180":
      return 180;
    case "CUSTOM":
      return 90;
    default:
      return 90;
  }
}

async function getSlowMovingReportFn(query: SlowMovingReportQuery) {
  const { page, limit, skip, take } = resolvePagination(query);

  const where: Prisma.SlowMovingConfigurationWhereInput = {
    ...(query.isFlagged !== undefined ? { isFlagged: query.isFlagged } : {}),
    ...(query.definitionType ? { definitionType: query.definitionType } : {}),
    ...(query.productGroupId
      ? { product: { productGroupId: query.productGroupId } }
      : {}),
    ...(query.manufacturerId
      ? { product: { manufacturerId: query.manufacturerId } }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.slowMovingConfiguration.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            costPrice: true,
            productGroup: { select: { id: true, name: true } },
            manufacturer: { select: { id: true, name: true } },
            stock: {
              select: { quantity: true },
            },
          },
        },
      orderBy: { updatedAt: "desc" },
      skip,
      take,
    }),
    prisma.slowMovingConfiguration.count({ where }),
  ]);

  const itemsWithStock = items.map((config) => ({
    ...config,
    product: {
      ...config.product,
      totalStock: config.product.stock.reduce((sum, s) => sum + s.quantity.toNumber(), 0),
      stockValue: config.product.stock.reduce((sum, s) => sum + s.quantity.toNumber() * (config.product.costPrice?.toNumber() ?? 0), 0),
    },
  });

  return { items: itemsWithStock, meta: buildPaginationMeta(total, page, limit) };
}

export const getSlowMovingReport = getSlowMovingReportFn;