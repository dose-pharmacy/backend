import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays, isExpired } from "../../utils/date-time.js";
import type { PageQuery } from "../../utils/pagination.js";

export type ExpiryStatus = "EXPIRED" | "EXPIRING_WITHIN_6_MONTHS" | "EXPIRING_WITHIN_1_YEAR" | "NORMAL";

export type ExpiryDashboardQuery = PageQuery & {
  locationId?: string;
  productId?: string;
};

export type ExpiryWindow = {
  label: string;
  status: ExpiryStatus;
  daysFrom: number;
  daysTo: number;
  batches: ExpiryBatchItem[];
  totalQuantity: number;
  batchCount: number;
};

export type ExpiryBatchItem = {
  id: string;
  batchNumber: string;
  expiryDate: Date;
  daysRemaining: number;
  purchaseCost: number | null;
  status: ExpiryStatus;
  product: {
    id: string;
    name: string;
    sku: string;
    brand: string | null;
  };
  stock: {
    quantity: number;
    location: { id: string; name: string } | null;
  };
};

export type ExpiredProductsQuery = PageQuery & {
  search?: string;
  locationId?: string;
};

export type ExpiredProductItem = {
  productId: string;
  productName: string;
  sku: string;
  brand: string | null;
  isNarcotic: boolean;
  batchCount: number;
  totalExpiredQuantity: number;
  expiredBatches: Array<{
    id: string;
    batchNumber: string;
    expiryDate: Date;
    purchaseCost: number | null;
    quantity: number;
    locationId: string;
    locationName: string;
  }>;
};

export type ExpiryDashboardResult = {
  windows: ExpiryWindow[];
  summary: {
    expired: number;
    expiringWithin6Months: number;
    expiringWithin1Year: number;
    normal: number;
    totalBatches: number;
    totalQuantity: number;
  };
};

const SIX_MONTHS_DAYS = 180;
const ONE_YEAR_DAYS = 365;

function calculateExpiryStatus(expiryDate: Date): ExpiryStatus {
  if (isExpired(expiryDate)) {
    return "EXPIRED";
  }
  const today = startOfTodayUtc();
  const daysRemaining = Math.ceil((expiryDate.getTime() - today.getTime()) / 86_400_000);

  if (daysRemaining <= SIX_MONTHS_DAYS) {
    return "EXPIRING_WITHIN_6_MONTHS";
  }
  if (daysRemaining <= ONE_YEAR_DAYS) {
    return "EXPIRING_WITHIN_1_YEAR";
  }
  return "NORMAL";
}

export const expiryService = {
  async getDashboard(query: ExpiryDashboardQuery): Promise<ExpiryDashboardResult> {
    const today = startOfTodayUtc();
    const maxExpiryDate = addUtcDays(today, ONE_YEAR_DAYS);

    // Build where clause for batches - only batches with positive stock
    const where: Prisma.BatchWhereInput = {
      expiryDate: {
        lte: maxExpiryDate,
      },
      stock: {
        some: { quantity: { gt: 0 } },
      },
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const batches = await prisma.batch.findMany({
      where,
      select: {
        id: true,
        batchNumber: true,
        expiryDate: true,
        purchaseCost: true,
        productId: true,
        product: { select: { id: true, name: true, sku: true, brand: true } },
        stock: {
          where: {
            quantity: { gt: 0 },
            ...(query.locationId ? { locationId: query.locationId } : {}),
          },
          select: {
            quantity: true,
            locationId: true,
            location: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    // Transform batches into window items
    const items: ExpiryBatchItem[] = batches.flatMap((batch) => {
      if (batch.stock.length === 0) {
        return [];
      }
      return batch.stock.map((stock) => {
        const quantity = stock.quantity.toNumber();
        const status = calculateExpiryStatus(batch.expiryDate);
        const today = startOfTodayUtc();
        const daysRemaining = Math.ceil((batch.expiryDate.getTime() - today.getTime()) / 86_400_000);

        return {
          id: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          daysRemaining,
          purchaseCost: batch.purchaseCost?.toNumber() ?? null,
          status,
          product: {
            id: batch.product.id,
            name: batch.product.name,
            sku: batch.product.sku,
            brand: batch.product.brand,
          },
          stock: {
            quantity,
            location: stock.location,
          },
        };
      });
    });

    // Group into windows based on new business model
    const windows: ExpiryWindow[] = [
      {
        label: "Expired",
        status: "EXPIRED",
        daysFrom: -Infinity,
        daysTo: -1,
        batches: items.filter((item) => item.status === "EXPIRED"),
        totalQuantity: items.filter((item) => item.status === "EXPIRED").reduce((sum, item) => sum + item.stock.quantity, 0),
        batchCount: items.filter((item) => item.status === "EXPIRED").length,
      },
      {
        label: "Expiring Within 6 Months",
        status: "EXPIRING_WITHIN_6_MONTHS",
        daysFrom: 0,
        daysTo: SIX_MONTHS_DAYS,
        batches: items.filter((item) => item.status === "EXPIRING_WITHIN_6_MONTHS"),
        totalQuantity: items.filter((item) => item.status === "EXPIRING_WITHIN_6_MONTHS").reduce((sum, item) => sum + item.stock.quantity, 0),
        batchCount: items.filter((item) => item.status === "EXPIRING_WITHIN_6_MONTHS").length,
      },
      {
        label: "Expiring Within 1 Year",
        status: "EXPIRING_WITHIN_1_YEAR",
        daysFrom: SIX_MONTHS_DAYS + 1,
        daysTo: ONE_YEAR_DAYS,
        batches: items.filter((item) => item.status === "EXPIRING_WITHIN_1_YEAR"),
        totalQuantity: items.filter((item) => item.status === "EXPIRING_WITHIN_1_YEAR").reduce((sum, item) => sum + item.stock.quantity, 0),
        batchCount: items.filter((item) => item.status === "EXPIRING_WITHIN_1_YEAR").length,
      },
      {
        label: "Normal (Beyond 1 Year)",
        status: "NORMAL",
        daysFrom: ONE_YEAR_DAYS + 1,
        daysTo: Infinity,
        batches: items.filter((item) => item.status === "NORMAL"),
        totalQuantity: items.filter((item) => item.status === "NORMAL").reduce((sum, item) => sum + item.stock.quantity, 0),
        batchCount: items.filter((item) => item.status === "NORMAL").length,
      },
    ];

    // Calculate summary
    const summary = {
      expired: items.filter((i) => i.status === "EXPIRED").length,
      expiringWithin6Months: items.filter((i) => i.status === "EXPIRING_WITHIN_6_MONTHS").length,
      expiringWithin1Year: items.filter((i) => i.status === "EXPIRING_WITHIN_1_YEAR").length,
      normal: items.filter((i) => i.status === "NORMAL").length,
      totalBatches: items.length,
      totalQuantity: items.reduce((sum, item) => sum + item.stock.quantity, 0),
    };

    return { windows, summary };
  },

  async getBatchesByWindow(
    query: ExpiryDashboardQuery & { windowStart: number; windowEnd: number },
  ) {
    const today = startOfTodayUtc();
    const startDate = addUtcDays(today, query.windowStart);
    const endDate = addUtcDays(today, query.windowEnd);

    const where: Prisma.BatchWhereInput = {
      expiryDate: {
        gte: startDate,
        lte: endDate,
      },
      stock: {
        some: { quantity: { gt: 0 }, ...(query.locationId ? { locationId: query.locationId } : {}) },
      },
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const { page, limit, skip, take } = resolvePagination(query);

    const [batches, total] = await prisma.$transaction([
      prisma.batch.findMany({
        where,
        select: {
          id: true,
          batchNumber: true,
          expiryDate: true,
          purchaseCost: true,
          productId: true,
          product: { select: { id: true, name: true, sku: true, brand: true } },
          stock: {
            where: {
              quantity: { gt: 0 },
              ...(query.locationId ? { locationId: query.locationId } : {}),
            },
            select: {
              quantity: true,
              locationId: true,
              location: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { expiryDate: "asc" },
        skip,
        take,
      }),
      prisma.batch.count({ where }),
    ]);

    const items: ExpiryBatchItem[] = batches.flatMap((batch) => {
      if (batch.stock.length === 0) {
        return [];
      }
      return batch.stock.map((stock) => {
        const quantity = stock.quantity.toNumber();
        const status = calculateExpiryStatus(batch.expiryDate);
        const daysRemaining = Math.ceil((batch.expiryDate.getTime() - today.getTime()) / 86_400_000);

        return {
          id: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          daysRemaining,
          purchaseCost: batch.purchaseCost?.toNumber() ?? null,
          status,
          product: {
            id: batch.product.id,
            name: batch.product.name,
            sku: batch.product.sku,
            brand: batch.product.brand,
          },
          stock: {
            quantity,
            location: stock.location,
          },
        };
      });
    });

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /**
   * Product-level view of expired stock. Pages over products instead of
   * batches (unlike getBatchesByWindow) so a single expired product that has
   * many expired batches/locations appears once, with an aggregated quantity
   * and the matching batch rows underneath.
   */
  async getExpiredProducts(query: ExpiredProductsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const today = startOfTodayUtc();

    const expiredStockFilter: Prisma.InventoryStockWhereInput = {
      quantity: { gt: 0 },
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };

    const productWhere: Prisma.ProductWhereInput = {
      batches: {
        some: {
          expiryDate: { lt: today },
          stock: { some: expiredStockFilter },
        },
      },
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

    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where: productWhere,
        select: { id: true },
        orderBy: { name: "asc" },
        skip,
        take,
      }),
      prisma.product.count({ where: productWhere }),
    ]);

    if (products.length === 0) {
      return { items: [], meta: buildPaginationMeta(0, page, limit) };
    }

    const batches = await prisma.batch.findMany({
      where: {
        productId: { in: products.map((p) => p.id) },
        expiryDate: { lt: today },
        stock: { some: expiredStockFilter },
      },
      select: {
        id: true,
        batchNumber: true,
        expiryDate: true,
        purchaseCost: true,
        product: {
          select: { id: true, name: true, sku: true, brand: true, isNarcotic: true },
        },
        stock: {
          where: expiredStockFilter,
          select: {
            quantity: true,
            location: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    const byProduct = new Map<string, ExpiredProductItem>();
    for (const batch of batches) {
      const rows = batch.stock.map((stock) => ({
        id: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        purchaseCost: batch.purchaseCost?.toNumber() ?? null,
        quantity: stock.quantity.toNumber(),
        locationId: stock.location?.id ?? "",
        locationName: stock.location?.name ?? "Unknown",
      }));
      let item = byProduct.get(batch.product.id);
      if (!item) {
        item = {
          productId: batch.product.id,
          productName: batch.product.name,
          sku: batch.product.sku,
          brand: batch.product.brand,
          isNarcotic: batch.product.isNarcotic,
          batchCount: 0,
          totalExpiredQuantity: 0,
          expiredBatches: [],
        };
        byProduct.set(batch.product.id, item);
      }
      if (rows.length > 0) {
        item.batchCount += 1;
        item.expiredBatches.push(...rows);
        item.totalExpiredQuantity += rows.reduce((sum, r) => sum + r.quantity, 0);
      }
    }

    const items = products
      .map((product) => byProduct.get(product.id))
      .filter((item): item is ExpiredProductItem => item !== undefined);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};