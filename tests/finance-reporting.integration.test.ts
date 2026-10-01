import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";
import {
  getFinanceDashboard,
  getFinanceReport,
  getFinanceTrends,
} from "../src/services/finance-reporting/finance-reporting.service.js";

// Neon is slow; the default 30s hook timeout produces spurious failures.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const prisma = new PrismaClient();

/**
 * A fixed window far in the future so no other suite's real-time data can sway
 * the exact assertions. `from`/`to` are the inclusive UTC calendar bounds the
 * endpoint accepts; the seeded events sit on Mar 10 / Mar 11.
 */
const RANGE_FROM = new Date("2031-03-09T00:00:00.000Z");
const RANGE_TO = new Date("2031-03-12T00:00:00.000Z");
const DAY1 = new Date("2031-03-10T10:00:00.000Z");
const DAY2 = new Date("2031-03-11T11:00:00.000Z");
const EMPTY_FROM = new Date("2032-01-01T00:00:00.000Z");
const EMPTY_TO = new Date("2032-01-02T00:00:00.000Z");

let dbReady = false;
let userId: string | undefined;

let groupId: string;
let unitId: string;
let locationId: string;
let supplierId: string;
let productId: string;
let batchId: string;
let expiredBatchId: string;

async function cleanup() {
  if (!dbReady) return;
  await prisma.saleReturn.deleteMany({ where: { locationId } });
  await prisma.sale.deleteMany({ where: { locationId } });
  await prisma.purchaseReturn.deleteMany({ where: { locationId } });
  await prisma.supplierPayment.deleteMany({ where: { supplierId } });
  await prisma.supplierInvoice.deleteMany({ where: { supplierId } });
  await prisma.inventoryStock.deleteMany({ where: { locationId } });
  await prisma.batch.deleteMany({ where: { productId } });
  await prisma.productUnit.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.unit.deleteMany({ where: { id: unitId } });
  await prisma.productGroup.deleteMany({ where: { id: groupId } });
  await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
  await prisma.supplier.deleteMany({ where: { id: supplierId } });
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
    data: { name: `FinRep Group ${suffix}` },
  });
  groupId = group.id;

  const unit = await prisma.unit.create({
    data: { name: `FinRep Unit ${suffix}` },
  });
  unitId = unit.id;

  const location = await prisma.inventoryLocation.create({
    data: { name: `FinRep Location ${suffix}` },
  });
  locationId = location.id;

  const supplier = await prisma.supplier.create({
    data: { name: `FinRep Supplier ${suffix}` },
  });
  supplierId = supplier.id;

  const product = await prisma.product.create({
    data: {
      name: `FinRep Product ${suffix}`,
      sku: `FINREP-${suffix}`,
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

  const batch = await prisma.batch.create({
    data: {
      productId,
      batchNumber: `FINREP-BATCH-${suffix}`,
      expiryDate: new Date("2029-01-01T00:00:00.000Z"),
      purchaseCost: 6,
    },
  });
  batchId = batch.id;

  // An already-expired batch to exercise the expiry value buckets.
  const expiredBatch = await prisma.batch.create({
    data: {
      productId,
      batchNumber: `FINREP-EXPIRED-${suffix}`,
      expiryDate: new Date("2025-01-01T00:00:00.000Z"),
      purchaseCost: 6,
    },
  });
  expiredBatchId = expiredBatch.id;

  await prisma.inventoryStock.create({
    data: { productId, batchId, locationId, quantity: 1000 },
  });
  await prisma.inventoryStock.create({
    data: { productId, batchId: expiredBatchId, locationId, quantity: 10 },
  });

  // Sale A (COMPLETED): gross 30, bill discount 3, net 27, 2 lines, 30 units,
  // batch COGS (10+20)*6 = 180.
  const saleA = await prisma.sale.create({
    data: {
      saleNumber: `FINREP-A-${suffix}`,
      locationId,
      cashierId: userId,
      status: "COMPLETED",
      subtotal: 30,
      totalDiscount: 3,
      totalAmount: 27,
      paidAmount: 27,
      changeAmount: 0,
      completedAt: DAY1,
      createdAt: DAY1,
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
      payments: { create: [{ method: "CASH", amount: 27, createdAt: DAY1 }] },
    },
    include: { items: true },
  });

  // Cancelled sale: must never be counted.
  await prisma.sale.create({
    data: {
      saleNumber: `FINREP-B-${suffix}`,
      locationId,
      cashierId: userId,
      status: "CANCELLED",
      subtotal: 999,
      totalDiscount: 0,
      totalAmount: 999,
      paidAmount: 0,
      changeAmount: 0,
      createdAt: DAY2,
    },
  });

  // Customer return: refund 5, 1 unit restocked (returned COGS 6).
  await prisma.saleReturn.create({
    data: {
      returnNumber: `FINREP-R-${suffix}`,
      saleId: saleA.id,
      locationId,
      refundAmount: 5,
      refundMethod: "CASH",
      createdById: userId,
      createdAt: DAY1,
      items: {
        create: [
          {
            saleItemId: saleA.items[0].id,
            productId,
            unitId,
            quantity: 1,
            baseQuantity: 1,
            unitPrice: 1,
            netUnitPrice: 1,
            refundAmount: 5,
            restock: true,
            batchAllocations: { create: [{ batchId, baseQuantity: 1 }] },
          },
        ],
      },
    },
  });

  // A sale recorded "now" so the dashboard has something in today's window.
  await prisma.sale.create({
    data: {
      saleNumber: `FINREP-TODAY-${suffix}`,
      locationId,
      cashierId: userId,
      status: "COMPLETED",
      subtotal: 123,
      totalDiscount: 0,
      totalAmount: 123,
      paidAmount: 123,
      changeAmount: 0,
      completedAt: new Date(),
      items: {
        create: [
          {
            productId,
            unitId,
            quantity: 1,
            baseQuantity: 1,
            conversionFactor: 1,
            originalUnitPrice: 123,
            actualUnitPrice: 123,
            lineTotal: 123,
          },
        ],
      },
      payments: { create: [{ method: "CASH", amount: 123 }] },
    },
  });

  // Supplier invoice: total 100, outstanding 40 (partially paid).
  await prisma.supplierInvoice.create({
    data: {
      invoiceNumber: `FINREP-INV-${suffix}`,
      supplierId,
      purchaseOrderId: null,
      invoiceDate: DAY1,
      goodsAmount: 100,
      taxAmount: 0,
      additionalChargesAmount: 0,
      discountAmount: 0,
      totalAmount: 100,
      invoiceAmount: 100,
      outstandingBalance: 40,
      status: "PARTIALLY_PAID",
      createdById: userId,
    },
  });

  await prisma.supplierPayment.create({
    data: {
      supplierId,
      supplierInvoiceId: (
        await prisma.supplierInvoice.findFirstOrThrow({
          where: { supplierId },
          select: { id: true },
        })
      ).id,
      amount: 60,
      paymentDate: DAY1,
      recordedById: userId,
    },
  });

  // Return applied to an unpaid/partially-paid invoice (reduces payable).
  await prisma.purchaseReturn.create({
    data: {
      returnNumber: `FINREP-PR-1-${suffix}`,
      supplierId,
      productId,
      batchId,
      locationId,
      reason: "EXPIRED",
      quantity: 1,
      returnedDate: DAY1,
      debitNoteAmount: 20,
      unitCost: 20,
      appliedToPayable: 20,
      recordedById: userId,
    },
  });

  // Return after the invoice was fully paid (pure refund/credit effect).
  await prisma.purchaseReturn.create({
    data: {
      returnNumber: `FINREP-PR-2-${suffix}`,
      supplierId,
      productId,
      batchId,
      locationId,
      reason: "DAMAGED",
      quantity: 1,
      returnedDate: DAY1,
      debitNoteAmount: 10,
      unitCost: 10,
      appliedToPayable: 0,
      recordedById: userId,
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)(
  "finance reporting (integration)",
  () => {
    it("aggregates sales, returns, COGS and profitability for the period", async () => {
      if (!dbReady) return;

      const report = await getFinanceReport({
        from: RANGE_FROM,
        to: RANGE_TO,
        locationId,
        granularity: "DAY",
      });

      // Sales header aggregates (cancelled sale excluded).
      expect(report.summary.grossSales).toBe(30);
      expect(report.summary.discounts).toBe(3);
      expect(report.summary.netSales).toBe(27);
      expect(report.summary.customerReturns).toBe(5);
      expect(report.summary.netSalesAfterReturns).toBe(22);
      expect(report.summary.returnedCogs).toBe(6);
      expect(report.summary.cogs).toBe(174); // 180 - 6 returned
      expect(report.summary.grossProfit).toBe(-152); // 22 - 174

      const perf = report.salesPerformance;
      expect(perf.transactionCount).toBe(1);
      expect(perf.unitsSold).toBe(30);
      expect(perf.averageTransactionValue).toBe(27);
      expect(perf.byLocation).toHaveLength(1);
      expect(perf.byLocation[0].locationId).toBe(locationId);
      expect(perf.byLocation[0].netSales).toBe(27);
      expect(perf.byProductGroup).toHaveLength(1);
      expect(perf.byProductGroup[0].productGroupId).toBe(groupId);
      expect(perf.byProductGroup[0].lineRevenue).toBe(30);
      expect(perf.byProductGroup[0].unitsSold).toBe(30);

      expect(report.profitability.netSales).toBe(22);
      expect(report.profitability.cogs).toBe(174);
      expect(report.profitability.grossProfit).toBe(-152);
    });

    it("separates purchases from supplier cash and payables", async () => {
      if (!dbReady) return;

      const report = await getFinanceReport({ from: RANGE_FROM, to: RANGE_TO });

      // Period-scoped and therefore exact for this far-future window.
      expect(report.purchasing.grossPurchases).toBe(100);
      expect(report.purchasing.invoiceAmount).toBe(100);
      expect(report.purchasing.invoiceCount).toBe(1);
      expect(report.purchasing.supplierPayments).toBe(60);
      expect(report.purchasing.supplierReturns).toBe(30);
      expect(report.purchasing.netPurchases).toBe(70);
      // Supplier-return split (unpaid vs fully-paid behaviour).
      expect(report.purchasing.supplierReturnAppliedToPayable).toBe(20);
      expect(report.purchasing.supplierReturnCreditEffect).toBe(10);
      // Current (not period-scoped) balance.
      expect(report.purchasing.supplierOutstanding).toBeGreaterThanOrEqual(40);
    });

    it("reports customer collections and receivables", async () => {
      if (!dbReady) return;

      const report = await getFinanceReport({
        from: RANGE_FROM,
        to: RANGE_TO,
        locationId,
      });

      expect(report.collections.customerCollections).toBe(27);
      expect(report.collections.byPaymentMethod).toEqual([
        { method: "CASH", amount: 27 },
      ]);
      // Sale A is fully paid, so nothing is outstanding at this location.
      expect(report.collections.customerReceivables).toBe(0);
    });

    it("values inventory at base-unit price and batch cost with expiry buckets", async () => {
      if (!dbReady) return;

      const report = await getFinanceReport({
        from: RANGE_FROM,
        to: RANGE_TO,
        locationId,
      });

      // 1010 units at 6 (1000 current + 10 expired).
      expect(report.inventoryValue.totalValue).toBe(6060);
      expect(report.inventoryValue.batchCostValue).toBe(6060);
      expect(report.inventoryValue.totalQuantity).toBe(1010);
      expect(report.inventoryValue.stockedProducts).toBe(1);
      expect(report.inventoryValue.expiredValue).toBe(60);
      expect(report.inventoryValue.expiringWithin30DaysValue).toBe(0);

      const expired = report.inventoryValue.expiryBuckets.find(
        (b) => b.key === "EXPIRED",
      );
      const long = report.inventoryValue.expiryBuckets.find(
        (b) => b.key === "DAYS_180_PLUS",
      );
      expect(expired).toEqual({ key: "EXPIRED", value: 60, quantity: 10 });
      expect(long).toEqual({ key: "DAYS_180_PLUS", value: 6000, quantity: 1000 });
    });

    it("buckets daily trends with zero-filled gaps", async () => {
      if (!dbReady) return;

      const trends = await getFinanceTrends({
        from: RANGE_FROM,
        to: RANGE_TO,
        locationId,
        granularity: "DAY",
      });

      expect(trends.points).toHaveLength(4);
      expect(trends.points.map((p) => p.period)).toEqual([
        "2031-03-09",
        "2031-03-10",
        "2031-03-11",
        "2031-03-12",
      ]);

      const day1 = trends.points.find((p) => p.period === "2031-03-10")!;
      expect(day1.netSales).toBe(27);
      expect(day1.customerReturns).toBe(5);
      expect(day1.netSalesAfterReturns).toBe(22);
      expect(day1.transactionCount).toBe(1);
      expect(day1.unitsSold).toBe(30);
      expect(day1.customerCollections).toBe(27);

      // Cancelled sale on the 11th must not appear.
      const day2 = trends.points.find((p) => p.period === "2031-03-11")!;
      expect(day2.netSales).toBe(0);
      expect(day2.transactionCount).toBe(0);
    });

    it("returns real zeroes (never 500) for an empty period", async () => {
      if (!dbReady) return;

      const report = await getFinanceReport({
        from: EMPTY_FROM,
        to: EMPTY_TO,
        locationId,
      });

      expect(report.summary.grossSales).toBe(0);
      expect(report.summary.netSales).toBe(0);
      expect(report.summary.customerReturns).toBe(0);
      expect(report.summary.grossProfit).toBe(0);
      expect(report.summary.grossPurchases).toBe(0);
      expect(report.salesPerformance.transactionCount).toBe(0);
      expect(report.trends.points.every((p) => p.netSales === 0)).toBe(true);
    });

    it("rejects a reversed date range with a 422", async () => {
      if (!dbReady) return;

      await expect(
        getFinanceReport({
          from: new Date("2032-02-01T00:00:00.000Z"),
          to: new Date("2032-01-01T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
    });

    it("exposes a today-scoped dashboard snapshot", async () => {
      if (!dbReady) return;

      const dashboard = await getFinanceDashboard();
      expect(dashboard.todayNetSales).toBeGreaterThanOrEqual(123);
      expect(dashboard.todayGrossSales).toBeGreaterThanOrEqual(123);
      expect(dashboard.todayTransactionCount).toBeGreaterThanOrEqual(1);
      expect(dashboard.todayCustomerCollections).toBeGreaterThanOrEqual(123);
      expect(dashboard.outstandingSupplierPayables).toBeGreaterThanOrEqual(40);
      expect(typeof dashboard.customerReceivables).toBe("number");
      expect(Number.isFinite(dashboard.todaySupplierPayments)).toBe(true);
    });
  },
);

describe("finance reporting routes", () => {
  let server: ReturnType<typeof app.listen>;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) =>
      server.on("listening", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    "/api/v1/finance-reporting/dashboard",
    "/api/v1/finance-reporting/report",
    "/api/v1/finance-reporting/trends",
  ])("registers GET %s behind authentication", async (path) => {
    const res = await request(server).get(path);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
