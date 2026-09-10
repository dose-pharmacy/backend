import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays, isExpired } from "../../utils/date-time.js";
import type { PageQuery } from "../../utils/pagination.js";

export type ExpiryStatus = "EXPIRED" | "CRITICAL" | "EXPIRING_SOON" | "WARNING" | "NORMAL";

export type ExpiryDashboardQuery = PageQuery & {
  thresholds?: string;
  locationId?: string;
  productId?: string;
};

export type ExpiryWindow = {
  label: string;
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

export type ExpiryDashboardResult = {
  windows: ExpiryWindow[];
  summary: {
    expired: number;
    critical: number;
    expiringSoon: number;
    warning: number;
    normal: number;
    totalBatches: number;
    totalQuantity: number;
  };
};

function parseThresholds(value: string | undefined): number[] {
  if (!value) {
    return [30, 60, 90];
  }
  const parsed = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (parsed.length === 0 || parsed.length > 10) {
    return [30, 60, 90];
  }
  return parsed;
}

function calculateExpiryStatus(expiryDate: Date, thresholds: number[]): ExpiryStatus {
  if (isExpired(expiryDate)) {
    return "EXPIRED";
  }
  const today = startOfTodayUtc();
  const daysRemaining = Math.ceil((expiryDate.getTime() - today.getTime()) / 86_400_000);

  if (daysRemaining <= thresholds[0]) {
    return "CRITICAL";
  }
  if (daysRemaining <= thresholds[1]) {
    return "EXPIRING_SOON";
  }
  if (daysRemaining <= thresholds[2]) {
    return "WARNING";
  }
  return "NORMAL";
}

export const expiryService = {
  async getDashboard(query: ExpiryDashboardQuery): Promise<ExpiryDashboardResult> {
    const thresholds = parseThresholds(query.thresholds);
    const maxThreshold = thresholds[thresholds.length - 1] ?? 90;
    const maxExpiryDate = addUtcDays(startOfTodayUtc(), maxThreshold);

    // Build where clause for batches
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
        const status = calculateExpiryStatus(batch.expiryDate, thresholds);
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

    // Group into windows
    const windows: ExpiryWindow[] = [];
    let prevThreshold = 0;
    for (let i = 0; i < thresholds.length; i++) {
      const threshold = thresholds[i];
      const windowItems = items.filter(
        (item) => item.daysRemaining > prevThreshold && item.daysRemaining <= threshold,
      );
      const label = i === 0 ? `0-${threshold} days` : `${prevThreshold + 1}-${threshold} days`;
      windows.push({
        label,
        daysFrom: prevThreshold + (i === 0 ? 0 : 1),
        daysTo: threshold,
        batches: windowItems,
        totalQuantity: windowItems.reduce((sum, item) => sum + item.stock.quantity, 0),
        batchCount: windowItems.length,
      });
      prevThreshold = threshold;
    }

    // Add expired window
    const expiredItems = items.filter((item) => item.daysRemaining < 0);
    windows.unshift({
      label: "Expired",
      daysFrom: -Infinity,
      daysTo: -1,
      batches: expiredItems,
      totalQuantity: expiredItems.reduce((sum, item) => sum + item.stock.quantity, 0),
      batchCount: expiredItems.length,
    });

    // Calculate summary
    const summary = {
      expired: items.filter((i) => i.daysRemaining < 0).length,
      critical: items.filter((i) => i.status === "CRITICAL").length,
      expiringSoon: items.filter((i) => i.status === "EXPIRING_SOON").length,
      warning: items.filter((i) => i.status === "WARNING").length,
      normal: items.filter((i) => i.status === "NORMAL").length,
      totalBatches: items.length,
      totalQuantity: items.reduce((sum, item) => sum + item.stock.quantity, 0),
    };

    return { windows, summary };
  },

  async getBatchesByWindow(
    query: ExpiryDashboardQuery & { windowStart: number; windowEnd: number },
  ) {
    const thresholds = parseThresholds(query.thresholds);
    const { page, limit, skip, take } = resolvePagination(query);

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
        const status = calculateExpiryStatus(batch.expiryDate, thresholds);
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
};