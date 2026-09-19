import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getSalesTrend } from "../src/services/financials/reports/report-query.service.js";
import {
  fetchSalesTotals,
  resolveReportScope,
} from "../src/services/financials/reports/report-query.service.js";
import { getProfitabilitySummary } from "../src/services/financials/reports/profitability-report.service.js";
import { getProfitMarginSummary } from "../src/services/financials/financial-report.service.js";
import {
  evaluateSlowMoving,
  SLOW_MOVING_EVALUATION_LOCK_KEY,
} from "../src/services/financials/reports/slow-moving-evaluation.js";

const prisma = new PrismaClient();

/** Fixed window far from real data so assertions cannot be swayed by it. */
const WINDOW_FROM = new Date("2026-01-10T00:00:00.000Z");
const WINDOW_TO = new Date("2026-01-20T23:59:59.999Z");
const SALE_DAY_1 = new Date("2026-01-15T10:00:00.000Z");
const SALE_DAY_2 = new Date("2026-01-16T11:00:00.000Z");
/** Far in the past so the product is well beyond every threshold. */
const STALE_SALE_DAY = new Date("2026-01-18T12:00:00.000Z");

let dbReady = false;
let userId: string | undefined;

let groupId: string;
let productId: string;
let staleProductId: string;
let neverSoldProductId: string;
let unitId: string;
let batchId: string;
let staleBatchId: string;
let locationId: string;

async function cleanup() {
  if (!dbReady) return;
  // Sale deletes cascade to sale_item / sale_item_batch / sale_payment.
  await prisma.sale.deleteMany({ where: { locationId } });
  await prisma.slowMovingConfiguration.deleteMany({
    where: { productId: { in: [productId, staleProductId, neverSoldProductId] } },
  });
  await prisma.inventoryStock.deleteMany({ where: { locationId } });
  await prisma.saleItemBatch.deleteMany({ where: { batchId: { in: [batchId, staleBatchId] } } });
  await prisma.batch.deleteMany({ where: { id: { in: [batchId, staleBatchId] } } });
  await prisma.productUnit.deleteMany({ where: { productId: { in: [productId, staleProductId, neverSoldProductId] } } });
  await prisma.product.deleteMany({ where: { id: { in: [productId, staleProductId, neverSoldProductId] } } });
  await prisma.unit.deleteMany({ where: { id: unitId } });
  await prisma.productGroup.deleteMany({ where: { id: groupId } });
  await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
}

beforeAll(async () => {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    dbReady = true;
  } catch {
    dbReady = false;
    return;
  }

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    dbReady = false;
    return;
  }
  userId = user.id;

  const suffix = Math.random().toString(36).slice(2, 10);
  const group = await prisma.productGroup.create({
    data: { name: `Report Test Group ${suffix}` },
  });
  groupId = group.id;

  const unit = await prisma.unit.create({ data: { name: `Report Test Unit ${suffix}` } });
  unitId = unit.id;

  const location = await prisma.inventoryLocation.create({
    data: { name: `Report Test Location ${suffix}` },
  });
  locationId = location.id;

  const product = await prisma.product.create({
    data: {
      name: `Report Test Product ${suffix}`,
      sku: `RPT-${suffix}`,
      productGroupId: groupId,
      units: {
        create: {
          unitId,
          conversionFactor: 1,
          isBaseUnit: true,
          sellPrice: 10,
          purchasePrice: 6,
        },
      },
    },
  });
  productId = product.id;

  const stale = await prisma.product.create({
    data: {
      name: `Report Stale Product ${suffix}`,
      sku: `RPT-STALE-${suffix}`,
      productGroupId: groupId,
      units: { create: { unitId, conversionFactor: 1, isBaseUnit: true, sellPrice: 10, purchasePrice: 5 } },
    },
  });
  staleProductId = stale.id;

  const neverSold = await prisma.product.create({
    data: {
      name: `Report Never Sold Product ${suffix}`,
      sku: `RPT-NEVER-${suffix}`,
      productGroupId: groupId,
      units: { create: { unitId, conversionFactor: 1, isBaseUnit: true, sellPrice: 10, purchasePrice: 5 } },
    },
  });
  neverSoldProductId = neverSold.id;

  const batch = await prisma.batch.create({
    data: {
      productId,
      batchNumber: `RPT-BATCH-${suffix}`,
      expiryDate: new Date("2028-01-01T00:00:00.000Z"),
      purchaseCost: 6,
    },
  });
  batchId = batch.id;

  const staleBatch = await prisma.batch.create({
    data: {
      productId: staleProductId,
      batchNumber: `RPT-STALE-BATCH-${suffix}`,
      expiryDate: new Date("2028-01-01T00:00:00.000Z"),
      purchaseCost: 6,
    },
  });
  staleBatchId = staleBatch.id;

  await prisma.inventoryStock.create({
    data: { productId, batchId, locationId, quantity: 1000 },
  });

  // Sale A: two lines, one sale -> transactionCount must stay 1.
  // Revenue 10 + 20 = 30, batch COGS (10+20) * 6 = 180, quantity 30.
  await prisma.sale.create({
    data: {
      saleNumber: `RPT-A-${suffix}`,
      locationId,
      cashierId: userId,
      status: "COMPLETED",
      subtotal: 30,
      totalDiscount: 0,
      totalAmount: 30,
      paidAmount: 30,
      changeAmount: 0,
      completedAt: SALE_DAY_1,
      createdAt: SALE_DAY_1,
      items: {
        create: [
          {
            productId,
            unitId,
            quantity: 10,
            baseQuantity: 10,
            conversionFactor: 1,
            originalUnitPrice: 1,
            actualUnitPrice: 1,
            lineTotal: 10,
            batchAllocations: { create: [{ batchId, baseQuantity: 10 }] },
          },
          {
            productId,
            unitId,
            quantity: 20,
            baseQuantity: 20,
            conversionFactor: 1,
            originalUnitPrice: 1,
            actualUnitPrice: 1,
            lineTotal: 20,
            batchAllocations: { create: [{ batchId, baseQuantity: 20 }] },
          },
        ],
      },
      payments: { create: [{ method: "CASH", amount: 30 }] },
    },
  });

  // Sale B: cancelled -> must never be counted.
  await prisma.sale.create({
    data: {
      saleNumber: `RPT-B-${suffix}`,
      locationId,
      cashierId: userId,
      status: "CANCELLED",
      subtotal: 999,
      totalDiscount: 0,
      totalAmount: 999,
      paidAmount: 0,
      changeAmount: 0,
      createdAt: SALE_DAY_2,
    },
  });

  // A very old completed sale for the stale product (drives slow-moving).
  await prisma.sale.create({
    data: {
      saleNumber: `RPT-C-${suffix}`,
      locationId,
      cashierId: userId,
      status: "COMPLETED",
      subtotal: 100,
      totalDiscount: 0,
      totalAmount: 100,
      paidAmount: 100,
      changeAmount: 0,
      completedAt: STALE_SALE_DAY,
      createdAt: STALE_SALE_DAY,
      items: {
        create: [
          {
            productId: staleProductId,
            unitId,
            quantity: 10,
            baseQuantity: 10,
            conversionFactor: 1,
            originalUnitPrice: 10,
            actualUnitPrice: 10,
            lineTotal: 100,
            batchAllocations: { create: [{ batchId: staleBatchId, baseQuantity: 10 }] },
          },
        ],
      },
      payments: { create: [{ method: "CARD", amount: 100 }] },
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)("report aggregations (integration)", () => {
  it("buckets daily sales, zero-fills gaps and counts each sale once", async () => {
    const points = await getSalesTrend(
      { dateFrom: WINDOW_FROM, dateTo: WINDOW_TO, locationId },
      "DAILY",
    );
    expect(points).toHaveLength(11);
    const jan15 = points.find((p) => p.period === "2026-01-15");
    expect(jan15).toEqual({
      period: "2026-01-15",
      revenue: 30,
      transactionCount: 1,
      quantitySold: 30,
    });

    // Day with only a cancelled sale -> zero, not 999.
    const jan16 = points.find((p) => p.period === "2026-01-16");
    expect(jan16?.revenue).toBe(0);
    expect(jan16?.transactionCount).toBe(0);
  });

  it("buckets monthly and annually", async () => {
    const monthly = await getSalesTrend(
      { dateFrom: WINDOW_FROM, dateTo: WINDOW_TO, locationId },
      "MONTHLY",
    );
    expect(monthly).toEqual([
      { period: "2026-01", revenue: 130, transactionCount: 2, quantitySold: 40 },
    ]);

    const annual = await getSalesTrend(
      { dateFrom: WINDOW_FROM, dateTo: WINDOW_TO, locationId },
      "ANNUAL",
    );
    expect(annual).toEqual([
      { period: "2026", revenue: 130, transactionCount: 2, quantitySold: 40 },
    ]);
  });

  it("returns whole-dataset totals independent of pagination", async () => {
    const scope = resolveReportScope({ dateFrom: WINDOW_FROM, dateTo: WINDOW_TO, locationId });
    const totals = await fetchSalesTotals(scope);
    expect(totals.revenue).toBe(130);
    expect(totals.cost).toBe(240); // (10+20+10) * 6
    expect(totals.profit).toBe(-110);
    expect(totals.quantity).toBe(40);
    expect(totals.productCount).toBe(2);
  });

  it("summarises profitability for the filtered scope", async () => {
    const summary = await getProfitabilitySummary({
      dateFrom: WINDOW_FROM,
      dateTo: WINDOW_TO,
      locationId,
      productGroupId: groupId,
    });
    expect(summary.revenue).toBe(130);
    expect(summary.productCount).toBe(2);
    expect(Number.isFinite(summary.margin)).toBe(true);
  });

  it("summarises margins without NaN even for products with no sales", async () => {
    const summary = await getProfitMarginSummary({
      dateFrom: WINDOW_FROM,
      dateTo: WINDOW_TO,
      productGroupId: groupId,
    });
    expect(summary.productCount).toBe(3); // includes the never-sold product
    expect(Number.isFinite(summary.averageTargetMargin)).toBe(true);
    expect(Number.isFinite(summary.averageActualMargin)).toBe(true);
    expect(summary.belowTargetCount).toBeGreaterThanOrEqual(0);
  });

  it("returns zeroed aggregates for a window with no sales", async () => {
    const scope = resolveReportScope({
      dateFrom: new Date("2020-01-01"),
      dateTo: new Date("2020-01-02"),
      locationId,
    });
    const totals = await fetchSalesTotals(scope);
    expect(totals).toEqual({
      revenue: 0,
      cost: 0,
      profit: 0,
      margin: 0,
      quantity: 0,
      productCount: 0,
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("slow-moving evaluation (integration)", () => {
  it("flags products beyond the threshold, keeps never-sold products unflagged", async () => {
    await prisma.slowMovingConfiguration.createMany({
      data: [
        { productId: staleProductId, definitionType: "DAYS_30" },
        { productId: neverSoldProductId, definitionType: "DAYS_60" },
      ],
    });

    const result = await evaluateSlowMoving();
    expect(result.evaluated).toBeGreaterThanOrEqual(2);
    expect(result.unflagged).toBe(result.evaluated - result.flagged);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const stale = await prisma.slowMovingConfiguration.findUnique({
      where: { productId: staleProductId },
    });
    expect(stale?.isFlagged).toBe(true);
    expect(stale?.lastSaleDate?.toISOString()).toBe(STALE_SALE_DAY.toISOString());
    expect(stale?.daysSinceLastSale).toBeGreaterThanOrEqual(30);

    const never = await prisma.slowMovingConfiguration.findUnique({
      where: { productId: neverSoldProductId },
    });
    expect(never?.isFlagged).toBe(false);
    expect(never?.lastSaleDate).toBeNull();
    expect(never?.daysSinceLastSale).toBeNull();
  });

  it("is idempotent across repeated runs", async () => {
    const first = await evaluateSlowMoving();
    const snapshot = await prisma.slowMovingConfiguration.findMany({
      where: { productId: { in: [staleProductId, neverSoldProductId] } },
      select: { productId: true, isFlagged: true, lastSaleDate: true, daysSinceLastSale: true },
      orderBy: { productId: "asc" },
    });

    const second = await evaluateSlowMoving();
    const after = await prisma.slowMovingConfiguration.findMany({
      where: { productId: { in: [staleProductId, neverSoldProductId] } },
      select: { productId: true, isFlagged: true, lastSaleDate: true, daysSinceLastSale: true },
      orderBy: { productId: "asc" },
    });

    expect(second.evaluated).toBe(first.evaluated);
    expect(second.flagged).toBe(first.flagged);
    expect(after).toEqual(snapshot);
  });

  it("rejects a concurrent evaluation with 409 while the lock is held", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(${SLOW_MOVING_EVALUATION_LOCK_KEY}::bigint)`,
        );
        return evaluateSlowMoving();
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
