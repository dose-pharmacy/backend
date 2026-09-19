import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../../utils/pagination.js";
import { resolveSort, type SortOrder } from "../../../utils/reporting/sort.js";
import { resolveThresholdDays } from "./slow-moving-evaluation.js";
import type { PageQuery } from "../../../utils/pagination.js";

export type SlowMovingReportQuery = PageQuery & {
  productGroupId?: string;
  manufacturerId?: string;
  isFlagged?: boolean;
  definitionType?: "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM";
  sortBy?: string;
  sortOrder?: string;
};

export const SLOW_MOVING_REPORT_SORT_FIELDS = [
  "daysSinceLastSale",
  "lastSaleDate",
  "productName",
  "updatedAt",
] as const;
export type SlowMovingReportSortField =
  (typeof SLOW_MOVING_REPORT_SORT_FIELDS)[number];

function buildSlowMovingOrderBy(
  field: SlowMovingReportSortField,
  order: SortOrder,
): Prisma.SlowMovingConfigurationOrderByWithRelationInput {
  switch (field) {
    case "daysSinceLastSale":
      return { daysSinceLastSale: order };
    case "lastSaleDate":
      return { lastSaleDate: order };
    case "productName":
      return { product: { name: order } };
    case "updatedAt":
    default:
      return { updatedAt: order };
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

  const { field, order } = resolveSort(query, {
    allowed: SLOW_MOVING_REPORT_SORT_FIELDS,
    defaultField: "updatedAt",
    defaultOrder: "desc",
  });

  const [items, total] = await prisma.$transaction([
    prisma.slowMovingConfiguration.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            productGroup: { select: { id: true, name: true } },
            manufacturer: { select: { id: true, name: true } },
            // Reference cost lives on the base ProductUnit.
            units: {
              where: { isBaseUnit: true },
              select: { purchasePrice: true },
              take: 1,
            },
            stock: { select: { quantity: true } },
          },
        },
      },
      orderBy: buildSlowMovingOrderBy(field, order),
      skip,
      take,
    }),
    prisma.slowMovingConfiguration.count({ where }),
  ]);

  const itemsWithStock = items.map((config) => {
    const unitCost = config.product.units[0]?.purchasePrice?.toNumber() ?? 0;
    const totalStock = config.product.stock.reduce(
      (sum, level) => sum + level.quantity.toNumber(),
      0,
    );

    return {
      ...config,
      thresholdDays: resolveThresholdDays(
        config.definitionType,
        config.customDays,
      ),
      product: {
        ...config.product,
        totalStock,
        stockValue: totalStock * unitCost,
      },
    };
  });

  return { items: itemsWithStock, meta: buildPaginationMeta(total, page, limit) };
}

export const getSlowMovingReport = getSlowMovingReportFn;
