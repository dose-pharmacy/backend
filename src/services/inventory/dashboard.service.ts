import { prisma } from "../../database/prisma.js";
import { startOfTodayUtc, addUtcDays } from "../../utils/date-time.js";
import type { AuthenticatedUser } from "../../types/auth.js";

const SIX_MONTHS_DAYS = 180;
const ONE_YEAR_DAYS = 365;

export async function getDashboardMetrics(
  _user: AuthenticatedUser,
): Promise<{
  totalProducts: number;
  totalStock: number;
  lowStock: number;
  outOfStock: number;
  nearExpiry: number;
  expiredBatches: number;
  criticalExpiry: number;
  expiringWithin6Months: number;
  expiringWithin1Year: number;
}> {
  // For now, single-tenant: no business scope filtering needed
  // When business scope is added, filter by businessId

  const today = startOfTodayUtc();
  const sixMonthsDate = addUtcDays(today, SIX_MONTHS_DAYS);
  const oneYearDate = addUtcDays(today, ONE_YEAR_DAYS);

  const [
    totalProducts,
    totalStockAgg,
    lowStockCount,
    outOfStockCount,
    expiredBatchesCount,
    expiringWithin6MonthsCount,
    expiringWithin1YearCount,
  ] = await Promise.all([
    // Total active products
    prisma.product.count({
      where: { isActive: true },
    }),
    // Total stock quantity across all locations
    prisma.inventoryStock.aggregate({
      _sum: { quantity: true },
    }),
    // Low stock products (total stock <= effective reorder threshold but > 0)
    prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT s."productId")::bigint as count
      FROM "inventory_stock" s
      JOIN "product" p ON p.id = s."productId"
      WHERE p."isActive" = true
      GROUP BY p.id, p."minimumStock", p."reorderPoint"
      HAVING SUM(s.quantity) > 0 AND SUM(s.quantity) <= COALESCE(p."reorderPoint", p."minimumStock")
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
    // Expired batches with stock
    prisma.batch.count({
      where: {
        expiryDate: {
          lt: today,
        },
        stock: {
          some: { quantity: { gt: 0 } },
        },
      },
    }),
    // Expiring within 6 months (has stock, not expired)
    prisma.batch.count({
      where: {
        expiryDate: {
          gte: today,
          lte: sixMonthsDate,
        },
        stock: {
          some: { quantity: { gt: 0 } },
        },
      },
    }),
    // Expiring within 1 year (has stock, not expired, beyond 6 months)
    prisma.batch.count({
      where: {
        expiryDate: {
          gte: sixMonthsDate,
          lte: oneYearDate,
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
    nearExpiry: expiringWithin6MonthsCount, // For backward compatibility
    expiredBatches: expiredBatchesCount,
    criticalExpiry: expiringWithin6MonthsCount, // For backward compatibility
    expiringWithin6Months: expiringWithin6MonthsCount,
    expiringWithin1Year: expiringWithin1YearCount,
  };
}