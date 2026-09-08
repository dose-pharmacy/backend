import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { startOfTodayUtc, isExpired, addUtcDays } from "../../utils/date-time.js";
import type { AuthenticatedUser } from "../../types/auth.js";

const DEFAULT_THRESHOLDS = [30, 60, 90];

function parseThresholds(value: string | undefined): number[] {
  if (!value) {
    return DEFAULT_THRESHOLDS;
  }
  const parsed = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (parsed.length === 0 || parsed.length > 10) {
    return DEFAULT_THRESHOLDS;
  }
  return parsed;
}

export async function getDashboardMetrics(
  user: AuthenticatedUser,
  thresholds?: string,
): Promise<{
  totalProducts: number;
  totalStock: number;
  lowStock: number;
  outOfStock: number;
  nearExpiry: number;
  expiredBatches: number;
  criticalExpiry: number;
}> {
  // For now, single-tenant: no business scope filtering needed
  // When business scope is added, filter by businessId

  const thresholdDays = parseThresholds(thresholds);
  const maxThreshold = thresholdDays[thresholdDays.length - 1] ?? 90;
  const maxExpiryDate = addUtcDays(startOfTodayUtc(), maxThreshold);

  const [
    totalProducts,
    totalStockAgg,
    lowStockCount,
    outOfStockCount,
    nearExpiryCount,
    expiredBatchesCount,
    criticalExpiryCount,
  ] = await Promise.all([
    // Total active products
    prisma.product.count({
      where: { isActive: true },
    }),
    // Total stock quantity across all locations
    prisma.inventoryStock.aggregate({
      _sum: { quantity: true },
    }),
    // Low stock products (total stock <= minimumStock but > 0)
    prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT s."productId")::bigint as count
      FROM "inventory_stock" s
      JOIN "product" p ON p.id = s."productId"
      WHERE p."isActive" = true
      GROUP BY p.id, p."minimumStock"
      HAVING SUM(s.quantity) > 0 AND SUM(s.quantity) <= p."minimumStock"
    `.then((rows) => Number(rows[0]?.count ?? 0)),
    // Out of stock products (total stock = 0)
    prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT p.id)::bigint as count
      FROM "product" p
      WHERE p."isActive" = true
      AND NOT EXISTS (
        SELECT 1 FROM "inventory_stock" s
        WHERE s."productId" = p.id AND s.quantity > 0
      )
    `.then((rows) => Number(rows[0]?.count ?? 0)),
    // Near expiry batches (within max threshold, not expired, has stock)
    prisma.batch.count({
      where: {
        expiryDate: {
          gte: startOfTodayUtc(),
          lte: maxExpiryDate,
        },
        stock: {
          some: { quantity: { gt: 0 } },
        },
      },
    }),
    // Expired batches with stock
    prisma.batch.count({
      where: {
        expiryDate: {
          lt: startOfTodayUtc(),
        },
        stock: {
          some: { quantity: { gt: 0 } },
        },
      },
    }),
    // Critical expiry batches (within first threshold, e.g., 30 days)
    prisma.batch.count({
      where: {
        expiryDate: {
          gte: startOfTodayUtc(),
          lte: addUtcDays(startOfTodayUtc(), thresholdDays[0] ?? 30),
        },
        stock: {
          some: { quantity: { gt: 0 } },
        },
      },
    }),
  ]);

  return {
    totalProducts,
    totalStock: totalStockAgg._sum.quantity?.toNumber() ?? 0,
    lowStock: lowStockCount,
    outOfStock: outOfStockCount,
    nearExpiry: nearExpiryCount,
    expiredBatches: expiredBatchesCount,
    criticalExpiry: criticalExpiryCount,
  };
}