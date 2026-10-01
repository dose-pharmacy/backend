// ── Finance Reporting Service ───────────────────────────────────────────────
//
// A NEW, read-only financial aggregation layer over the pharmacy's existing
// canonical business events. It deliberately does NOT introduce a ledger, does
// NOT write anything, and does NOT modify any existing finance endpoint.
//
// Design rules honoured here:
//  · Database does all aggregation (CTEs / GROUP BY / SUM); Node only receives
//    already-aggregated rows. No N+1 and no loading whole tables into memory.
//  · A valid sale is `Sale.status = COMPLETED`; `createdAt` is the reporting
//    timestamp. Cancelled/draft sales are never counted (same rule as the
//    existing report-query service).
//  · The date window is resolved through the shared `resolveReportDateRange`
//    helper, so `to` includes the WHOLE final UTC day (equivalent to a
//    half-open `>= from AND < dayAfter(to)` range for ms-precision columns).
//  · Customer returns reduce revenue via SaleReturn.refundAmount (recorded on
//    the return, never written back into the sale or its payments).
//  · Supplier returns use the hardened PurchaseReturn linkage:
//      debitNoteAmount            = total value returned
//      appliedToPayable           = value that reduced outstanding payables
//      debitNoteAmount - applied  = supplier refund/credit effect
//    Historical invoices/payments are never rewritten.
//  · SupplierPayment has NO payment-method column, so supplier payment
//    breakdowns by method are impossible and are intentionally not offered.
//  · "Today" always means UTC midnight onward (existing convention).
//  · Empty periods return real zeroes, never null/undefined/500.

import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { addUtcDays, startOfTodayUtc } from "../../utils/date-time.js";
import {
  resolveReportDateRange,
  toSqlTimestamp,
} from "../../utils/reporting/date-range.js";
import {
  enumerateBuckets,
  periodBucket,
  type ReportPeriod,
} from "../../utils/reporting/period.js";
import {
  fetchOutstandingCredit,
  safeRatio,
  toNumber,
} from "../financials/reports/report-query.service.js";
import type {
  CollectionsSection,
  FinanceDashboard,
  FinancePeriod,
  FinanceReport,
  FinanceReportQuery,
  FinanceScopeInput,
  FinanceSummary,
  FinanceTrendPoint,
  FinanceTrends,
  InventoryValueBucket,
  InventoryValueSection,
  PaymentMethodTotal,
  PurchasingSection,
  SalesPerformance,
  SectionBasis,
  TrendGranularity,
} from "./finance-reporting.types.js";

const DAY_MS = 86_400_000;
const VALID_SALE_STATUS = "COMPLETED" as const;

// ── Scope resolution ────────────────────────────────────────────────────────

type ResolvedScope = {
  start: Date;
  end: Date;
  locationId?: string;
  productGroupId?: string;
};

function resolveScope(input: FinanceScopeInput = {}): ResolvedScope {
  const { start, end } = resolveReportDateRange({
    dateFrom: input.from,
    dateTo: input.to,
  });
  return {
    start,
    end,
    locationId: input.locationId,
    productGroupId: input.productGroupId,
  };
}

function todayScope(): ResolvedScope {
  const start = startOfTodayUtc();
  return { start, end: new Date(start.getTime() + DAY_MS - 1) };
}

// ── SQL predicate builders ──────────────────────────────────────────────────

function and(parts: Prisma.Sql[]): Prisma.Sql {
  return Prisma.join(parts, " AND ");
}

/** Predicate over `sale s` for a valid sale inside the scope. */
function salePredicate(scope: ResolvedScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`s.status = ${VALID_SALE_STATUS}::"SaleStatus"`,
    Prisma.sql`s."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp`,
    Prisma.sql`s."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp`,
  ];
  if (scope.locationId) {
    parts.push(Prisma.sql`s."locationId" = ${scope.locationId}`);
  }
  if (scope.productGroupId) {
    parts.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM sale_item xsi
        JOIN product xp ON xp.id = xsi."productId"
        WHERE xsi."saleId" = s.id
          AND xp."productGroupId" = ${scope.productGroupId}
      )`,
    );
  }
  return and(parts);
}

/**
 * Predicate over `sale_item si JOIN sale s JOIN product p` for sale lines in
 * the scope. `p` must be joined by the caller.
 */
function linePredicate(scope: ResolvedScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`s.status = ${VALID_SALE_STATUS}::"SaleStatus"`,
    Prisma.sql`s."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp`,
    Prisma.sql`s."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp`,
  ];
  if (scope.locationId) {
    parts.push(Prisma.sql`s."locationId" = ${scope.locationId}`);
  }
  if (scope.productGroupId) {
    parts.push(Prisma.sql`p."productGroupId" = ${scope.productGroupId}`);
  }
  return and(parts);
}

/** Predicate over `sale_return sr` for customer returns in the scope. */
function returnPredicate(scope: ResolvedScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`sr."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp`,
    Prisma.sql`sr."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp`,
  ];
  if (scope.locationId) {
    parts.push(Prisma.sql`sr."locationId" = ${scope.locationId}`);
  }
  if (scope.productGroupId) {
    parts.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM sale_return_item xri
        JOIN product xp ON xp.id = xri."productId"
        WHERE xri."returnId" = sr.id
          AND xp."productGroupId" = ${scope.productGroupId}
      )`,
    );
  }
  return and(parts);
}

// ── Sales core ──────────────────────────────────────────────────────────────

type SalesCore = {
  grossSales: number;
  discounts: number;
  netSales: number;
  transactionCount: number;
  unitsSold: number;
  cogs: number;
  customerReturns: number;
  returnedCogs: number;
};

/**
 * One database round-trip for the sale header aggregates, line quantity, and
 * batch-level COGS — kept in separate CTEs so a sale with several batch
 * allocations is never double-counted in revenue or transaction count.
 */
async function fetchSalesCore(scope: ResolvedScope): Promise<SalesCore> {
  const saleWhere = salePredicate(scope);
  const lineWhere = linePredicate(scope);
  const returnWhere = returnPredicate(scope);

  const rows = await prisma.$queryRaw<
    Array<{
      grossSales: unknown;
      discounts: unknown;
      netSales: unknown;
      transactionCount: unknown;
      unitsSold: unknown;
      cogs: unknown;
      customerReturns: unknown;
      returnedCogs: unknown;
    }>
  >(Prisma.sql`
    WITH scoped AS (
      SELECT s.id, s."subtotal", s."totalDiscount", s."totalAmount"
      FROM sale s
      WHERE ${saleWhere}
    ),
    line AS (
      SELECT COALESCE(SUM(si."baseQuantity"), 0) AS units
      FROM sale_item si
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      WHERE ${lineWhere}
    ),
    cogs AS (
      SELECT COALESCE(SUM(sib."baseQuantity" * COALESCE(b."purchaseCost", 0)), 0) AS cost
      FROM sale_item_batch sib
      JOIN sale_item si ON si.id = sib."saleItemId"
      JOIN sale s ON s.id = si."saleId"
      JOIN product p ON p.id = si."productId"
      JOIN batch b ON b.id = sib."batchId"
      WHERE ${lineWhere}
    ),
    ret AS (
      SELECT COALESCE(SUM(sr."refundAmount"), 0) AS refund
      FROM sale_return sr
      WHERE ${returnWhere}
    ),
    ret_cogs AS (
      SELECT COALESCE(SUM(srib."baseQuantity" * COALESCE(b."purchaseCost", 0)), 0) AS cost
      FROM sale_return_item_batch srib
      JOIN sale_return_item sri ON sri.id = srib."saleReturnItemId"
      JOIN sale_return sr ON sr.id = sri."returnId"
      JOIN batch b ON b.id = srib."batchId"
      WHERE ${returnWhere}
    )
    SELECT
      COALESCE((SELECT SUM("subtotal") FROM scoped), 0) AS "grossSales",
      COALESCE((SELECT SUM("totalDiscount") FROM scoped), 0) AS "discounts",
      COALESCE((SELECT SUM("totalAmount") FROM scoped), 0) AS "netSales",
      (SELECT COUNT(*)::int FROM scoped) AS "transactionCount",
      (SELECT units FROM line) AS "unitsSold",
      (SELECT cost FROM cogs) AS "cogs",
      (SELECT refund FROM ret) AS "customerReturns",
      (SELECT cost FROM ret_cogs) AS "returnedCogs"
  `);

  const row = rows[0];
  return {
    grossSales: toNumber(row?.grossSales),
    discounts: toNumber(row?.discounts),
    netSales: toNumber(row?.netSales),
    transactionCount: toNumber(row?.transactionCount),
    unitsSold: toNumber(row?.unitsSold),
    cogs: toNumber(row?.cogs),
    customerReturns: toNumber(row?.customerReturns),
    returnedCogs: toNumber(row?.returnedCogs),
  };
}

async function fetchSalesByLocation(
  scope: ResolvedScope,
): Promise<SalesPerformance["byLocation"]> {
  const where = salePredicate(scope);
  const rows = await prisma.$queryRaw<
    Array<{
      locationId: string;
      locationName: string;
      netSales: unknown;
      discounts: unknown;
      transactionCount: unknown;
    }>
  >(Prisma.sql`
    SELECT s."locationId" AS "locationId",
           l.name AS "locationName",
           COALESCE(SUM(s."totalAmount"), 0) AS "netSales",
           COALESCE(SUM(s."totalDiscount"), 0) AS "discounts",
           COUNT(*)::int AS "transactionCount"
    FROM sale s
    JOIN inventory_location l ON l.id = s."locationId"
    WHERE ${where}
    GROUP BY s."locationId", l.name
    ORDER BY "netSales" DESC
  `);

  return rows.map((r) => ({
    locationId: r.locationId,
    locationName: r.locationName,
    netSales: toNumber(r.netSales),
    discounts: toNumber(r.discounts),
    transactionCount: toNumber(r.transactionCount),
  }));
}

async function fetchSalesByProductGroup(
  scope: ResolvedScope,
): Promise<SalesPerformance["byProductGroup"]> {
  const where = linePredicate(scope);
  const rows = await prisma.$queryRaw<
    Array<{
      productGroupId: string;
      productGroupName: string;
      lineRevenue: unknown;
      unitsSold: unknown;
    }>
  >(Prisma.sql`
    SELECT pg.id AS "productGroupId",
           pg.name AS "productGroupName",
           COALESCE(SUM(si."lineTotal"), 0) AS "lineRevenue",
           COALESCE(SUM(si."baseQuantity"), 0) AS "unitsSold"
    FROM sale_item si
    JOIN sale s ON s.id = si."saleId"
    JOIN product p ON p.id = si."productId"
    JOIN product_group pg ON pg.id = p."productGroupId"
    WHERE ${where}
    GROUP BY pg.id, pg.name
    ORDER BY "lineRevenue" DESC
  `);

  return rows.map((r) => ({
    productGroupId: r.productGroupId,
    productGroupName: r.productGroupName,
    lineRevenue: toNumber(r.lineRevenue),
    unitsSold: toNumber(r.unitsSold),
  }));
}

async function fetchCollections(
  scope: ResolvedScope,
): Promise<{ total: number; byMethod: PaymentMethodTotal[] }> {
  const rows = await prisma.$queryRaw<
    Array<{ method: string; amount: unknown }>
  >(Prisma.sql`
    SELECT sp.method::text AS method,
           COALESCE(SUM(sp.amount), 0) AS amount
    FROM sale_payment sp
    JOIN sale s ON s.id = sp."saleId"
    WHERE s.status = ${VALID_SALE_STATUS}::"SaleStatus"
      AND sp."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp
      AND sp."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp
      ${scope.locationId ? Prisma.sql`AND s."locationId" = ${scope.locationId}` : Prisma.empty}
    GROUP BY sp.method
    ORDER BY sp.method ASC
  `);

  const byMethod = rows.map((r) => ({
    method: r.method,
    amount: toNumber(r.amount),
  }));
  const total = byMethod.reduce((sum, r) => sum + r.amount, 0);
  return { total, byMethod };
}

// ── Purchasing (company-wide) ───────────────────────────────────────────────
//
// Supplier invoices and payments carry no location or product-group link, so
// these figures are always whole-company. Reporting them filtered would
// silently produce a different basis from grossPurchases, so we do not.

async function fetchPurchasing(scope: ResolvedScope): Promise<PurchasingSection> {
  const start = toSqlTimestamp(scope.start);
  const end = toSqlTimestamp(scope.end);

  const rows = await prisma.$queryRaw<
    Array<Record<string, unknown>>
  >(Prisma.sql`
    SELECT
      COALESCE((SELECT SUM(i."totalAmount") FROM supplier_invoice i
                WHERE i."invoiceDate" >= ${start}::timestamp AND i."invoiceDate" <= ${end}::timestamp), 0) AS "grossPurchases",
      (SELECT COUNT(*)::int FROM supplier_invoice i
       WHERE i."invoiceDate" >= ${start}::timestamp AND i."invoiceDate" <= ${end}::timestamp) AS "invoiceCount",
      COALESCE((SELECT SUM(pr."debitNoteAmount") FROM purchase_return pr
                WHERE pr."returnedDate" >= ${start}::timestamp AND pr."returnedDate" <= ${end}::timestamp), 0) AS "supplierReturns",
      (SELECT COUNT(*)::int FROM purchase_return pr
       WHERE pr."returnedDate" >= ${start}::timestamp AND pr."returnedDate" <= ${end}::timestamp) AS "supplierReturnCount",
      COALESCE((SELECT SUM(pr."appliedToPayable") FROM purchase_return pr
                WHERE pr."returnedDate" >= ${start}::timestamp AND pr."returnedDate" <= ${end}::timestamp), 0) AS "supplierReturnAppliedToPayable",
      COALESCE((SELECT SUM(pr."debitNoteAmount" - pr."appliedToPayable") FROM purchase_return pr
                WHERE pr."returnedDate" >= ${start}::timestamp AND pr."returnedDate" <= ${end}::timestamp), 0) AS "supplierReturnCreditEffect",
      COALESCE((SELECT SUM(sp.amount) FROM supplier_payment sp
                WHERE sp."paymentDate" >= ${start}::timestamp AND sp."paymentDate" <= ${end}::timestamp), 0) AS "supplierPayments",
      (SELECT COUNT(*)::int FROM supplier_payment sp
       WHERE sp."paymentDate" >= ${start}::timestamp AND sp."paymentDate" <= ${end}::timestamp) AS "supplierPaymentCount",
      COALESCE((SELECT SUM(i."outstandingBalance") FROM supplier_invoice i
                WHERE i.status IN ('OPEN'::"SupplierInvoiceStatus", 'PARTIALLY_PAID'::"SupplierInvoiceStatus")), 0) AS "supplierOutstanding",
      (SELECT COUNT(*)::int FROM supplier_invoice i
       WHERE i.status IN ('OPEN'::"SupplierInvoiceStatus", 'PARTIALLY_PAID'::"SupplierInvoiceStatus")) AS "outstandingInvoiceCount",
      (SELECT COUNT(*)::int FROM purchase_order po
       WHERE po."orderDate" >= ${start}::timestamp AND po."orderDate" <= ${end}::timestamp
         AND po.status <> 'CANCELLED'::"PurchaseOrderStatus") AS "purchaseOrderCount"
  `);

  const r = rows[0] ?? {};
  const grossPurchases = toNumber(r.grossPurchases);
  const supplierReturns = toNumber(r.supplierReturns);
  return {
    grossPurchases,
    supplierReturns,
    netPurchases: grossPurchases - supplierReturns,
    invoiceAmount: grossPurchases,
    supplierPayments: toNumber(r.supplierPayments),
    supplierOutstanding: toNumber(r.supplierOutstanding),
    purchaseOrderCount: toNumber(r.purchaseOrderCount),
    invoiceCount: toNumber(r.invoiceCount),
    supplierReturnCount: toNumber(r.supplierReturnCount),
    supplierPaymentCount: toNumber(r.supplierPaymentCount),
    outstandingInvoiceCount: toNumber(r.outstandingInvoiceCount),
    supplierReturnAppliedToPayable: toNumber(r.supplierReturnAppliedToPayable),
    supplierReturnCreditEffect: toNumber(r.supplierReturnCreditEffect),
  };
}

// ── Inventory value ─────────────────────────────────────────────────────────

type InventoryQueryRow = {
  totalValue: unknown;
  batchCostValue: unknown;
  totalQuantity: unknown;
  stockedProducts: unknown;
  expiredValue: unknown;
  expiring30Value: unknown;
  expiredQty: unknown;
  b0_30Qty: unknown;
  b31_90Qty: unknown;
  b91_180Qty: unknown;
  b180PlusQty: unknown;
  v0_30: unknown;
  v31_90: unknown;
  v91_180: unknown;
  v180Plus: unknown;
};

async function fetchInventoryValue(
  scope: ResolvedScope,
): Promise<InventoryValueSection> {
  const today = startOfTodayUtc();
  const in30 = addUtcDays(today, 30);
  const in90 = addUtcDays(today, 90);
  const in180 = addUtcDays(today, 180);

  const filters: Prisma.Sql[] = [];
  if (scope.locationId) {
    filters.push(Prisma.sql`s."locationId" = ${scope.locationId}`);
  }
  if (scope.productGroupId) {
    filters.push(Prisma.sql`p."productGroupId" = ${scope.productGroupId}`);
  }
  const extra = filters.length ? Prisma.sql`AND ${and(filters)}` : Prisma.empty;

  const rows = await prisma.$queryRaw<InventoryQueryRow[]>(Prisma.sql`
    SELECT
      COALESCE(SUM(s.quantity * pu."purchasePrice"), 0) AS "totalValue",
      COALESCE(SUM(s.quantity * COALESCE(b."purchaseCost", 0)), 0) AS "batchCostValue",
      COALESCE(SUM(s.quantity), 0) AS "totalQuantity",
      COUNT(DISTINCT CASE WHEN s.quantity > 0 THEN s."productId" END)::int AS "stockedProducts",
      COALESCE(SUM(CASE WHEN b."expiryDate" < ${toSqlTimestamp(today)}::timestamp
                        THEN s.quantity * COALESCE(b."purchaseCost", 0) ELSE 0 END), 0) AS "expiredValue",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(today)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in30)}::timestamp
                        THEN s.quantity * COALESCE(b."purchaseCost", 0) ELSE 0 END), 0) AS "expiring30Value",
      COALESCE(SUM(CASE WHEN b."expiryDate" < ${toSqlTimestamp(today)}::timestamp THEN s.quantity ELSE 0 END), 0) AS "expiredQty",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(today)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in30)}::timestamp THEN s.quantity ELSE 0 END), 0) AS "b0_30Qty",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(in30)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in90)}::timestamp THEN s.quantity ELSE 0 END), 0) AS "b31_90Qty",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(in90)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in180)}::timestamp THEN s.quantity ELSE 0 END), 0) AS "b91_180Qty",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(in180)}::timestamp THEN s.quantity ELSE 0 END), 0) AS "b180PlusQty",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(today)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in30)}::timestamp
                        THEN s.quantity * COALESCE(b."purchaseCost", 0) ELSE 0 END), 0) AS "v0_30",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(in30)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in90)}::timestamp
                        THEN s.quantity * COALESCE(b."purchaseCost", 0) ELSE 0 END), 0) AS "v31_90",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(in90)}::timestamp
                          AND b."expiryDate" < ${toSqlTimestamp(in180)}::timestamp
                        THEN s.quantity * COALESCE(b."purchaseCost", 0) ELSE 0 END), 0) AS "v91_180",
      COALESCE(SUM(CASE WHEN b."expiryDate" >= ${toSqlTimestamp(in180)}::timestamp
                        THEN s.quantity * COALESCE(b."purchaseCost", 0) ELSE 0 END), 0) AS "v180Plus"
    FROM inventory_stock s
    JOIN batch b ON b.id = s."batchId"
    JOIN product p ON p.id = s."productId"
    LEFT JOIN product_unit pu
      ON pu."productId" = s."productId"
     AND pu."isBaseUnit" = true
    WHERE 1 = 1 ${extra}
  `);

  const r = rows[0];
  const expiryBuckets: InventoryValueBucket[] = [
    { key: "EXPIRED", value: toNumber(r?.expiredValue), quantity: toNumber(r?.expiredQty) },
    { key: "DAYS_0_30", value: toNumber(r?.v0_30), quantity: toNumber(r?.b0_30Qty) },
    { key: "DAYS_31_90", value: toNumber(r?.v31_90), quantity: toNumber(r?.b31_90Qty) },
    { key: "DAYS_91_180", value: toNumber(r?.v91_180), quantity: toNumber(r?.b91_180Qty) },
    { key: "DAYS_180_PLUS", value: toNumber(r?.v180Plus), quantity: toNumber(r?.b180PlusQty) },
  ];

  return {
    totalValue: toNumber(r?.totalValue),
    batchCostValue: toNumber(r?.batchCostValue),
    totalQuantity: toNumber(r?.totalQuantity),
    stockedProducts: toNumber(r?.stockedProducts),
    expiredValue: toNumber(r?.expiredValue),
    expiringWithin30DaysValue: toNumber(r?.expiring30Value),
    expiryBuckets,
  };
}

// ── Trends ──────────────────────────────────────────────────────────────────

function mapGranularity(g: TrendGranularity): ReportPeriod {
  if (g === "YEAR") return "ANNUAL";
  if (g === "MONTH") return "MONTHLY";
  return "DAILY";
}

type BucketRow = {
  period: string;
  grossSales?: unknown;
  discounts?: unknown;
  netSales?: unknown;
  transactionCount?: unknown;
  unitsSold?: unknown;
  cogs?: unknown;
  customerReturns?: unknown;
  customerCollections?: unknown;
  supplierPayments?: unknown;
  supplierReturns?: unknown;
};

async function fetchTrendBuckets(
  scope: ResolvedScope,
  granularity: TrendGranularity,
): Promise<Map<string, BucketRow>> {
  const period = mapGranularity(granularity);
  const { trunc, format } = periodBucket(period);
  const saleWhere = salePredicate(scope);
  const lineWhere = linePredicate(scope);
  const returnWhere = returnPredicate(scope);

  const [salesRows, collectionRows, supplierRows] = await Promise.all([
    prisma.$queryRaw<BucketRow[]>(Prisma.sql`
      WITH sale_b AS (
        SELECT to_char(date_trunc(${trunc}, s."createdAt"), ${format}) AS period,
               COALESCE(SUM(s."subtotal"), 0) AS "grossSales",
               COALESCE(SUM(s."totalDiscount"), 0) AS "discounts",
               COALESCE(SUM(s."totalAmount"), 0) AS "netSales",
               COUNT(*)::int AS "transactionCount"
        FROM sale s
        WHERE ${saleWhere}
        GROUP BY 1
      ),
      line_b AS (
        SELECT to_char(date_trunc(${trunc}, s."createdAt"), ${format}) AS period,
               COALESCE(SUM(si."baseQuantity"), 0) AS "unitsSold"
        FROM sale_item si
        JOIN sale s ON s.id = si."saleId"
        JOIN product p ON p.id = si."productId"
        WHERE ${lineWhere}
        GROUP BY 1
      ),
      cogs_b AS (
        SELECT to_char(date_trunc(${trunc}, s."createdAt"), ${format}) AS period,
               COALESCE(SUM(sib."baseQuantity" * COALESCE(b."purchaseCost", 0)), 0) AS cogs
        FROM sale_item_batch sib
        JOIN sale_item si ON si.id = sib."saleItemId"
        JOIN sale s ON s.id = si."saleId"
        JOIN product p ON p.id = si."productId"
        JOIN batch b ON b.id = sib."batchId"
        WHERE ${lineWhere}
        GROUP BY 1
      ),
      ret_b AS (
        SELECT to_char(date_trunc(${trunc}, sr."createdAt"), ${format}) AS period,
               COALESCE(SUM(sr."refundAmount"), 0) AS "customerReturns"
        FROM sale_return sr
        WHERE ${returnWhere}
        GROUP BY 1
      )
      SELECT COALESCE(sb.period, lb.period, cb.period, rb.period) AS period,
             sb."grossSales" AS "grossSales",
             sb."discounts" AS "discounts",
             sb."netSales" AS "netSales",
             sb."transactionCount" AS "transactionCount",
             lb."unitsSold" AS "unitsSold",
             cb.cogs AS cogs,
             rb."customerReturns" AS "customerReturns"
      FROM sale_b sb
      FULL OUTER JOIN line_b lb ON lb.period = sb.period
      FULL OUTER JOIN cogs_b cb ON cb.period = COALESCE(sb.period, lb.period)
      FULL OUTER JOIN ret_b rb ON rb.period = COALESCE(sb.period, lb.period, cb.period)
    `),
    prisma.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT to_char(date_trunc(${trunc}, sp."createdAt"), ${format}) AS period,
             COALESCE(SUM(sp.amount), 0) AS "customerCollections"
      FROM sale_payment sp
      JOIN sale s ON s.id = sp."saleId"
      WHERE s.status = ${VALID_SALE_STATUS}::"SaleStatus"
        AND sp."createdAt" >= ${toSqlTimestamp(scope.start)}::timestamp
        AND sp."createdAt" <= ${toSqlTimestamp(scope.end)}::timestamp
        ${scope.locationId ? Prisma.sql`AND s."locationId" = ${scope.locationId}` : Prisma.empty}
      GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ kind: string; period: string; amount: unknown }>>(Prisma.sql`
      SELECT 'PAYMENT' AS kind,
             to_char(date_trunc(${trunc}, sp."paymentDate"), ${format}) AS period,
             COALESCE(SUM(sp.amount), 0) AS amount
      FROM supplier_payment sp
      WHERE sp."paymentDate" >= ${toSqlTimestamp(scope.start)}::timestamp
        AND sp."paymentDate" <= ${toSqlTimestamp(scope.end)}::timestamp
      GROUP BY 2
      UNION ALL
      SELECT 'RETURN' AS kind,
             to_char(date_trunc(${trunc}, pr."returnedDate"), ${format}) AS period,
             COALESCE(SUM(pr."debitNoteAmount"), 0) AS amount
      FROM purchase_return pr
      WHERE pr."returnedDate" >= ${toSqlTimestamp(scope.start)}::timestamp
        AND pr."returnedDate" <= ${toSqlTimestamp(scope.end)}::timestamp
      GROUP BY 2
    `),
  ]);

  const byPeriod = new Map<string, BucketRow>();
  const ensure = (key: string): BucketRow => {
    const existing = byPeriod.get(key);
    if (existing) return existing;
    const created: BucketRow = { period: key };
    byPeriod.set(key, created);
    return created;
  };

  for (const row of salesRows) {
    Object.assign(ensure(row.period), row);
  }
  for (const row of collectionRows) {
    ensure(row.period).customerCollections = row.customerCollections;
  }
  for (const row of supplierRows) {
    const target = ensure(row.period);
    if (row.kind === "PAYMENT") target.supplierPayments = row.amount;
    else target.supplierReturns = row.amount;
  }

  return byPeriod;
}

async function buildTrends(
  scope: ResolvedScope,
  granularity: TrendGranularity,
): Promise<FinanceTrends> {
  const period = mapGranularity(granularity);
  const byPeriod = await fetchTrendBuckets(scope, granularity);

  const points: FinanceTrendPoint[] = enumerateBuckets(
    scope.start,
    scope.end,
    period,
  ).map((key) => {
    const row = byPeriod.get(key);
    const grossSales = toNumber(row?.grossSales);
    const discounts = toNumber(row?.discounts);
    const netSales = row?.netSales !== undefined ? toNumber(row.netSales) : grossSales - discounts;
    const customerReturns = toNumber(row?.customerReturns);
    const netSalesAfterReturns = netSales - customerReturns;
    const cogs = toNumber(row?.cogs);
    const grossProfit = netSalesAfterReturns - cogs;
    return {
      period: key,
      grossSales,
      discounts,
      netSales,
      customerReturns,
      netSalesAfterReturns,
      cogs,
      grossProfit,
      grossMargin: safeRatio(grossProfit, netSalesAfterReturns),
      transactionCount: toNumber(row?.transactionCount),
      unitsSold: toNumber(row?.unitsSold),
      customerCollections: toNumber(row?.customerCollections),
      supplierPayments: toNumber(row?.supplierPayments),
      supplierReturns: toNumber(row?.supplierReturns),
    };
  });

  return {
    granularity,
    from: scope.start.toISOString(),
    to: scope.end.toISOString(),
    points,
  };
}

// ── Public: dashboard ───────────────────────────────────────────────────────

export async function getFinanceDashboard(): Promise<FinanceDashboard> {
  const scope = todayScope();

  const [
    salesAgg,
    returnsAgg,
    supplierPaymentsAgg,
    supplierReturnsAgg,
    outstandingAgg,
    collections,
    receivables,
  ] = await Promise.all([
    prisma.sale.aggregate({
      where: { status: VALID_SALE_STATUS, createdAt: { gte: scope.start, lte: scope.end } },
      _sum: { subtotal: true, totalDiscount: true, totalAmount: true },
      _count: true,
    }),
    prisma.saleReturn.aggregate({
      where: { createdAt: { gte: scope.start, lte: scope.end } },
      _sum: { refundAmount: true },
    }),
    prisma.supplierPayment.aggregate({
      where: { paymentDate: { gte: scope.start, lte: scope.end } },
      _sum: { amount: true },
    }),
    prisma.purchaseReturn.aggregate({
      where: { returnedDate: { gte: scope.start, lte: scope.end } },
      _sum: { debitNoteAmount: true },
    }),
    prisma.supplierInvoice.aggregate({
      where: { status: { in: ["OPEN", "PARTIALLY_PAID"] } },
      _sum: { outstandingBalance: true },
    }),
    prisma.salePayment.aggregate({
      where: {
        createdAt: { gte: scope.start, lte: scope.end },
        sale: { status: VALID_SALE_STATUS },
      },
      _sum: { amount: true },
    }),
    fetchOutstandingCredit(),
  ]);

  const grossSales = toNumber(salesAgg._sum.subtotal);
  const discounts = toNumber(salesAgg._sum.totalDiscount);
  const netSales = toNumber(salesAgg._sum.totalAmount);
  const customerReturns = toNumber(returnsAgg._sum.refundAmount);

  return {
    asOf: new Date().toISOString(),
    todayGrossSales: grossSales,
    todayDiscounts: discounts,
    todayCustomerReturns: customerReturns,
    todayNetSales: netSales,
    todayNetSalesAfterReturns: netSales - customerReturns,
    todayTransactionCount: salesAgg._count ?? 0,
    todayCustomerCollections: toNumber(collections._sum.amount),
    todaySupplierPayments: toNumber(supplierPaymentsAgg._sum.amount),
    todaySupplierReturns: toNumber(supplierReturnsAgg._sum.debitNoteAmount),
    outstandingSupplierPayables: toNumber(outstandingAgg._sum.outstandingBalance),
    customerReceivables: receivables,
  };
}

// ── Public: report ──────────────────────────────────────────────────────────

export async function getFinanceReport(
  input: FinanceReportQuery,
): Promise<FinanceReport> {
  const scope = resolveScope(input);
  const granularity: TrendGranularity = input.granularity ?? "MONTH";

  const [
    sales,
    byLocation,
    byProductGroup,
    purchasing,
    collections,
    inventoryValue,
    trends,
  ] = await Promise.all([
    fetchSalesCore(scope),
    fetchSalesByLocation(scope),
    fetchSalesByProductGroup(scope),
    fetchPurchasing(scope),
    fetchCollections(scope),
    fetchInventoryValue(scope),
    buildTrends(scope, granularity),
  ]);

  // COGS is reduced by the batch cost of returned goods so gross profit is not
  // understated when customers return restocked inventory.
  const cogsNet = sales.cogs - sales.returnedCogs;
  const netSalesAfterReturns = sales.netSales - sales.customerReturns;
  const grossProfit = netSalesAfterReturns - cogsNet;

  const summary: FinanceSummary = {
    grossSales: sales.grossSales,
    discounts: sales.discounts,
    netSales: sales.netSales,
    customerReturns: sales.customerReturns,
    netSalesAfterReturns,
    cogs: cogsNet,
    returnedCogs: sales.returnedCogs,
    grossProfit,
    grossMargin: safeRatio(grossProfit, netSalesAfterReturns),
    grossPurchases: purchasing.grossPurchases,
    supplierReturns: purchasing.supplierReturns,
    netPurchases: purchasing.netPurchases,
    supplierPayments: purchasing.supplierPayments,
    supplierOutstanding: purchasing.supplierOutstanding,
    customerCollections: collections.total,
    customerReceivables: await fetchOutstandingCredit({
      locationId: scope.locationId,
    }),
  };

  const salesPerformance: SalesPerformance = {
    grossSales: sales.grossSales,
    discounts: sales.discounts,
    customerReturns: sales.customerReturns,
    netSales: sales.netSales,
    netSalesAfterReturns,
    transactionCount: sales.transactionCount,
    unitsSold: sales.unitsSold,
    averageTransactionValue:
      sales.transactionCount > 0
        ? Math.round((sales.netSales / sales.transactionCount) * 100) / 100
        : 0,
    byPaymentMethod: collections.byMethod,
    byLocation,
    byProductGroup,
  };

  const collectionsSection: CollectionsSection = {
    customerCollections: collections.total,
    customerReceivables: summary.customerReceivables,
    byPaymentMethod: collections.byMethod,
  };

  const scopeNotes = {
    salesPerformance: sectionBasis(
      "REPORT_SCOPE",
      "Respects the requested period, location and product-group filters.",
    ),
    purchasing: sectionBasis(
      "COMPANY",
      "Supplier invoices and payments have no location/product link; reported company-wide for the period.",
    ),
    collections: sectionBasis(
      "REPORT_SCOPE",
      "Respects the requested period and location; product-group filtering is not attributable to payments.",
    ),
    inventoryValue: sectionBasis(
      "REPORT_SCOPE",
      "Current stock value; respects location and product-group filters.",
    ),
  };

  const period: FinancePeriod = {
    from: scope.start.toISOString(),
    to: scope.end.toISOString(),
    fromDate: scope.start.toISOString().slice(0, 10),
    toDate: scope.end.toISOString().slice(0, 10),
    locationId: scope.locationId ?? null,
    productGroupId: scope.productGroupId ?? null,
    granularity,
  };

  return {
    period,
    summary,
    salesPerformance,
    purchasing,
    collections: collectionsSection,
    profitability: {
      netSales: netSalesAfterReturns,
      cogs: cogsNet,
      grossProfit,
      grossMargin: safeRatio(grossProfit, netSalesAfterReturns),
    },
    inventoryValue,
    trends,
    scopeNotes,
  };
}

// ── Public: trends ──────────────────────────────────────────────────────────

export async function getFinanceTrends(
  input: FinanceReportQuery,
): Promise<FinanceTrends> {
  const scope = resolveScope(input);
  return buildTrends(scope, input.granularity ?? "DAY");
}

function sectionBasis(
  basis: SectionBasis["basis"],
  note: string,
): SectionBasis {
  return { basis, note };
}

export const financeReportingService = {
  getFinanceDashboard,
  getFinanceReport,
  getFinanceTrends,
};
