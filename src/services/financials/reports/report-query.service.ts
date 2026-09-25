import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { resolveReportDateRange, toSqlTimestamp } from "../../../utils/reporting/date-range.js";
import {
  enumerateBuckets,
  periodBucket,
  type ReportPeriod,
} from "../../../utils/reporting/period.js";
import type { ReportDateRangeInput } from "../../../utils/reporting/date-range.js";

/**
 * ============================================================================
 * ReportQueryService
 * ============================================================================
 *
 * Single source of truth for "what counts as a valid sale" and for the
 * database-side aggregations shared by every reporting endpoint.
 *
 * A valid sale is a `Sale` with `status = COMPLETED`. Cancelled/voided sales
 * (status CANCELLED) and drafts are never counted. `createdAt` — the moment the
 * sale was recorded — is the reporting timestamp for every period filter.
 *
 * All heavy work happens in PostgreSQL (WHERE / GROUP BY / SUM / COUNT). The
 * only data pulled into Node is already aggregated per period or per product,
 * so a report never loads the whole `sale` / `sale_item` tables into memory.
 *
 * `SaleItem` is the canonical sale-line table (the POS checkout path), and it
 * carries `SaleItemBatch` allocations, which give us real batch-level cost of
 * goods sold for profitability reporting.
 */

export const VALID_SALE_STATUS = "COMPLETED" as const;

/** Structured scope for a report: an inclusive date range plus optional dims. */
export type ReportScope = ReportDateRangeInput & {
  locationId?: string;
  productGroupId?: string;
  manufacturerId?: string;
};

export type ResolvedReportScope = {
  start: Date;
  end: Date;
  locationId?: string;
  productGroupId?: string;
  manufacturerId?: string;
};

/**
 * Normalises and validates a report scope. Every report resolves its window
 * through here so date-boundary behaviour is identical everywhere.
 */
export function resolveReportScope(
  scope: ReportScope,
  options: { defaultDays?: number } = {},
): ResolvedReportScope {
  const { start, end } = resolveReportDateRange(scope, options);
  return {
    start,
    end,
    locationId: scope.locationId,
    productGroupId: scope.productGroupId,
    manufacturerId: scope.manufacturerId,
  };
}

/**
 * Prisma where-clause for valid sales in a resolved scope. Used by the sales
 * list/detail endpoints so their definition of "valid sale" can never drift
 * from the aggregations below.
 */
export function validSaleWhere(scope: ResolvedReportScope): Prisma.SaleWhereInput {
  return {
    status: VALID_SALE_STATUS,
    createdAt: { gte: scope.start, lte: scope.end },
    ...(scope.locationId ? { locationId: scope.locationId } : {}),
  };
}

/** Prisma where-clause for valid sale items in a resolved scope. */
export function validSaleItemWhere(
  scope: ResolvedReportScope,
): Prisma.SaleItemWhereInput {
  const productFilter: Prisma.ProductWhereInput = {
    ...(scope.productGroupId ? { productGroupId: scope.productGroupId } : {}),
    ...(scope.manufacturerId ? { manufacturerId: scope.manufacturerId } : {}),
  };
  return {
    sale: {
      status: VALID_SALE_STATUS,
      createdAt: { gte: scope.start, lte: scope.end },
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    },
    ...(Object.keys(productFilter).length > 0 ? { product: productFilter } : {}),
  };
}

/** SQL predicate shared by the raw aggregations (parameterised, no interpolation). */
function scopeSql(scope: ResolvedReportScope): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`s.status = ${VALID_SALE_STATUS}::"SaleStatus"`,
    Prisma.sql`s."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp`,
    Prisma.sql`s."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp`,
  ];
  // Bare parameters: Prisma binds these with the value's inferred type, which
  // lets PostgreSQL resolve uuid = uuid directly and still use the composite
  // indexes. Appending `::uuid` to a bound parameter breaks the comparison
  // (text = uuid), so the casts stay off.
  if (scope.locationId) {
    conditions.push(Prisma.sql`s."locationId" = ${scope.locationId}`);
  }
  if (scope.productGroupId) {
    conditions.push(Prisma.sql`p."productGroupId" = ${scope.productGroupId}`);
  }
  if (scope.manufacturerId) {
    conditions.push(Prisma.sql`p."manufacturerId" = ${scope.manufacturerId}`);
  }
  return Prisma.join(conditions, " AND ");
}

/** Converts a raw Postgres numeric/bigint aggregate into a finite JS number. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Prisma.Decimal) {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Rounds to 2 decimals and guards against NaN/Infinity leaking to clients. */
export function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  const value = (numerator / denominator) * 100;
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

export type ProductSalesAggregate = {
  productId: string;
  revenue: number;
  quantity: number;
  cost: number;
};

type RawProductSalesRow = {
  productId: string;
  revenue: unknown;
  quantity: unknown;
  cost: unknown;
};

/**
 * Per-product revenue / quantity / batch-level COGS for the scope, aggregated
 * entirely in the database. The two CTEs are kept separate so a product with
 * several batch allocations is never double-counted in revenue/quantity.
 */
export async function fetchProductSalesAggregates(
  scope: ResolvedReportScope,
): Promise<ProductSalesAggregate[]> {
  const predicate = scopeSql(scope);
  const rows = await prisma.$queryRaw<RawProductSalesRow[]>`
    WITH revenue AS (
      SELECT si."productId" AS product_id,
             COALESCE(SUM(si."lineTotal"), 0) AS revenue,
             COALESCE(SUM(si."baseQuantity"), 0) AS quantity
      FROM sale_item si
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      WHERE ${predicate}
      GROUP BY si."productId"
    ),
    cogs AS (
      SELECT si."productId" AS product_id,
             COALESCE(SUM(sib."baseQuantity" * COALESCE(b."purchaseCost", 0)), 0) AS cost
      FROM sale_item si
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      JOIN sale_item_batch sib ON sib."saleItemId" = si.id
      JOIN batch b ON b.id = sib."batchId"
      WHERE ${predicate}
      GROUP BY si."productId"
    )
    SELECT r.product_id AS "productId",
           r.revenue AS revenue,
           r.quantity AS quantity,
           COALESCE(c.cost, 0) AS cost
    FROM revenue r
    LEFT JOIN cogs c ON c.product_id = r.product_id
  `;

  return rows.map((row) => ({
    productId: row.productId,
    revenue: toNumber(row.revenue),
    quantity: toNumber(row.quantity),
    cost: toNumber(row.cost),
  }));
}

export type SalesTotals = {
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
  quantity: number;
  productCount: number;
};

/**
 * Whole-scope totals for the profitability summary: revenue, batch COGS,
 * quantity and distinct product count. Never depends on pagination.
 */
export async function fetchSalesTotals(
  scope: ResolvedReportScope,
): Promise<SalesTotals> {
  const predicate = scopeSql(scope);
  const rows = await prisma.$queryRaw<
    Array<{
      revenue: unknown;
      quantity: unknown;
      cost: unknown;
      productCount: unknown;
    }>
  >`
    WITH revenue AS (
      SELECT si."productId" AS product_id,
             COALESCE(SUM(si."lineTotal"), 0) AS revenue,
             COALESCE(SUM(si."baseQuantity"), 0) AS quantity
      FROM sale_item si
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      WHERE ${predicate}
      GROUP BY si."productId"
    ),
    cogs AS (
      SELECT si."productId" AS product_id,
             COALESCE(SUM(sib."baseQuantity" * COALESCE(b."purchaseCost", 0)), 0) AS cost
      FROM sale_item si
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      JOIN sale_item_batch sib ON sib."saleItemId" = si.id
      JOIN batch b ON b.id = sib."batchId"
      WHERE ${predicate}
      GROUP BY si."productId"
    )
    SELECT COALESCE(SUM(r.revenue), 0) AS revenue,
           COALESCE(SUM(r.quantity), 0) AS quantity,
           COALESCE(SUM(COALESCE(c.cost, 0)), 0) AS cost,
           COUNT(*)::int AS "productCount"
    FROM revenue r
    LEFT JOIN cogs c ON c.product_id = r.product_id
  `;

  const row = rows[0];
  const revenue = toNumber(row?.revenue);
  const cost = toNumber(row?.cost);
  const profit = revenue - cost;
  return {
    revenue,
    cost,
    profit,
    margin: safeRatio(profit, revenue),
    quantity: toNumber(row?.quantity),
    productCount: toNumber(row?.productCount),
  };
}

export type SalesTrendPoint = {
  period: string;
  revenue: number;
  transactionCount: number;
  quantitySold: number;
};

/**
 * Sales trend time series. Revenue and transaction count come from the `sale`
 * header (one row per sale, so transactions are never double-counted), while
 * quantity sold comes from the sale lines. Buckets with no sales are emitted
 * with zeros so the client never has to reconstruct the missing periods.
 */
export async function getSalesTrend(
  scope: ReportScope,
  period: ReportPeriod,
): Promise<SalesTrendPoint[]> {
  const resolved = resolveReportScope(scope);
  const predicate = scopeSql(resolved);
  const { trunc, format } = periodBucket(period);

  const [saleBuckets, lineBuckets] = await Promise.all([
    prisma.$queryRaw<Array<{ period: string; revenue: unknown; transactionCount: unknown }>>`
      SELECT to_char(date_trunc(${trunc}, s."createdAt"), ${format}) AS period,
             COALESCE(SUM(s."totalAmount"), 0) AS revenue,
             COUNT(*)::int AS "transactionCount"
      FROM sale s
      WHERE ${predicate}
      GROUP BY 1
    `,
    prisma.$queryRaw<Array<{ period: string; quantitySold: unknown }>>`
      SELECT to_char(date_trunc(${trunc}, s."createdAt"), ${format}) AS period,
             COALESCE(SUM(si."baseQuantity"), 0) AS "quantitySold"
      FROM sale_item si
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      WHERE ${predicate}
      GROUP BY 1
    `,
  ]);

  const revenueByPeriod = new Map(
    saleBuckets.map((row) => [row.period, row] as const),
  );
  const quantityByPeriod = new Map(
    lineBuckets.map((row) => [row.period, toNumber(row.quantitySold)] as const),
  );

  return enumerateBuckets(resolved.start, resolved.end, period).map((key) => {
    const saleRow = revenueByPeriod.get(key);
    return {
      period: key,
      revenue: toNumber(saleRow?.revenue),
      transactionCount: toNumber(saleRow?.transactionCount),
      quantitySold: quantityByPeriod.get(key) ?? 0,
    };
  });
}

/**
 * Payment totals per method for the scope, read from `SalePayment` — the table
 * actually written by the checkout path.
 */
export async function fetchPaymentTotalsByMethod(
  scope: ResolvedReportScope,
): Promise<Array<{ method: string; amount: number }>> {
  // `SalePayment` is the table written by the checkout path; the legacy
  // `Payment` model is unused, so grouping it would always return nothing.
  const rows = await prisma.salePayment.groupBy({
    by: ["method"],
    where: {
      sale: {
        status: VALID_SALE_STATUS,
        createdAt: { gte: scope.start, lte: scope.end },
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    },
    _sum: { amount: true },
    orderBy: { method: "asc" },
  });

  return rows.map((row) => ({
    method: row.method,
    amount: row._sum.amount?.toNumber() ?? 0,
  }));
}

/**
 * Collections (actual money received) per method for the scope, based on
 * SalePayment.createdAt (when money was actually collected), not sale date.
 * This is used for collection reporting where payment date matters.
 */
export async function fetchCollectionsByMethod(
  scope: ResolvedReportScope,
): Promise<Array<{ method: string; amount: number }>> {
  const rows = await prisma.salePayment.groupBy({
    by: ["method"],
    where: {
      createdAt: { gte: scope.start, lte: scope.end },
      sale: {
        status: VALID_SALE_STATUS,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    },
    _sum: { amount: true },
    orderBy: { method: "asc" },
  });

  return rows.map((row) => ({
    method: row.method,
    amount: row._sum.amount?.toNumber() ?? 0,
  }));
}

/**
 * Total collections for the scope (sum of all payments by payment date).
 */
export async function fetchTotalCollections(
  scope: ResolvedReportScope,
): Promise<number> {
  const result = await prisma.salePayment.aggregate({
    where: {
      createdAt: { gte: scope.start, lte: scope.end },
      sale: {
        status: VALID_SALE_STATUS,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    },
    _sum: { amount: true },
  });
  return toNumber(result._sum.amount);
}

/**
 * Current outstanding credit balance across all credit sales.
 * This is a current balance metric, not limited to the reporting period.
 * Outstanding = sum of (totalAmount - paidAmount) for sales with outstanding > 0.
 */
export async function fetchOutstandingCredit(
  scope: { locationId?: string } = {},
): Promise<number> {
  // Use raw SQL for accurate outstanding calculation
  const conditions: Prisma.Sql[] = [
    Prisma.sql`s.status = ${VALID_SALE_STATUS}::"SaleStatus"`,
    Prisma.sql`s."paidAmount" < s."totalAmount"`,
  ];
  if (scope.locationId) {
    conditions.push(Prisma.sql`s."locationId" = ${scope.locationId}`);
  }
  const predicate = Prisma.join(conditions, " AND ");

  const rows = await prisma.$queryRaw<
    Array<{ outstanding: unknown }>
  >`
    SELECT COALESCE(SUM(s."totalAmount" - s."paidAmount"), 0) AS outstanding
    FROM sale s
    WHERE ${predicate}
  `;

  return toNumber(rows[0]?.outstanding);
}

/**
 * Credit sales count - number of sales that have/had credit (customer info present).
 * Can be filtered by period (sales created in period) or show all currently outstanding.
 */
export async function fetchCreditSalesCount(
  scope: ResolvedReportScope,
  options: { includeHistorical?: boolean } = {},
): Promise<number> {
  const { includeHistorical = false } = options;
  const conditions: Prisma.Sql[] = [
    Prisma.sql`s.status = ${VALID_SALE_STATUS}::"SaleStatus"`,
    Prisma.sql`(s."customerName" IS NOT NULL OR s."customerPhone" IS NOT NULL)`,
  ];

  if (includeHistorical) {
    // Count all sales that ever had credit (customer info not null)
    // Period filter on sale createdAt
    conditions.push(
      Prisma.sql`s."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp`,
    );
    conditions.push(
      Prisma.sql`s."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp`,
    );
  } else {
    // Count only currently outstanding credit sales
    conditions.push(Prisma.sql`s."paidAmount" < s."totalAmount"`);
  }

  if (scope.locationId) {
    conditions.push(Prisma.sql`s."locationId" = ${scope.locationId}`);
  }
  if (scope.productGroupId) {
    // This would require joining through sale items - skip for now
  }

  const predicate = Prisma.join(conditions, " AND ");

  const rows = await prisma.$queryRaw<
    Array<{ count: unknown }>
  >`
    SELECT COUNT(*)::int AS count
    FROM sale s
    WHERE ${predicate}
  `;

  return toNumber(rows[0]?.count);
}

export const reportQueryService = {
  VALID_SALE_STATUS,
  resolveReportScope,
  validSaleWhere,
  validSaleItemWhere,
  fetchProductSalesAggregates,
  fetchSalesTotals,
  fetchPaymentTotalsByMethod,
  fetchCollectionsByMethod,
  fetchTotalCollections,
  fetchOutstandingCredit,
  fetchCreditSalesCount,
  getSalesTrend,
  toNumber,
  safeRatio,
};
