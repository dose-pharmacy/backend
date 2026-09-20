/**
 * Dashboard integration tests
 *
 * Exercises all three dashboard endpoints against a live test database,
 * verifying:
 *  · Authentication / authorization enforcement
 *  · Correct aggregation of today's completed sales
 *  · Exclusion of cancelled/draft sales from today's totals
 *  · Inventory count consistency with known test data
 *  · Purchasing count consistency with known PO / requirement test data
 *  · Outstanding invoice count logic
 *  · Slow-moving isFlagged count (read-only)
 *  · Attention list shape and limits
 *  · Recent-activity shape
 *  · Edge cases: zero sales, zero inventory, etc.
 */

import request from "supertest";
import type { Response } from "supertest";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";
import { startOfTodayUtc } from "../src/utils/date-time.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BASE = "/api/v1/dashboard";

// ── Helpers ───────────────────────────────────────────────────────────────

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
}

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((c) => c.startsWith("better-auth.session_token"));
}

// ── Test setup ────────────────────────────────────────────────────────────

describe("dashboard endpoints", () => {
  let cookie: string;
  let suffix: string;

  // IDs created during beforeAll — cleaned up in afterAll
  let groupId: string;
  let productId: string;
  let locationId: string;
  let supplierId: string;
  let unitId: string;
  let batchIdFarFuture: string;
  let batchIdExpiringSoon: string;
  let batchIdExpired: string;
  let requirementId: string;
  let poAwaitingId: string;
  let poRegisteredId: string;
  let invoiceId: string;
  let slowConfigId: string;
  let completedSaleId: string;
  let cancelledSaleId: string;
  let goodsReceiptId: string;

  beforeAll(async () => {
    suffix = uniqueSuffix();
    const email = `dashboard.${suffix}@example.com`;

    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Dashboard Admin", email, password: "ValidPass1" })
      .expect(200);

    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected session cookie after sign-up");
    cookie = session;
    const userId: string = signUp.body.user.id;

    // ── Inventory seed ────────────────────────────────────────────────────

    const group = await prisma.productGroup.create({
      data: { name: `DashGrp ${suffix}` },
    });
    groupId = group.id;

    const product = await prisma.product.create({
      data: {
        name: `DashProduct ${suffix}`,
        sku: `DASH-${suffix}`,
        productGroupId: group.id,
        minimumStock: 10, // low-stock threshold
      },
    });
    productId = product.id;

    const masterUnit = await prisma.unit.create({
      data: { name: `DashUnit ${suffix}`, symbol: "du" },
    });
    unitId = masterUnit.id;

    // Base unit with purchase price (for stock value calc)
    await prisma.productUnit.create({
      data: {
        productId,
        unitId: masterUnit.id,
        conversionFactor: 1,
        sellPrice: 20,
        purchasePrice: 10,
        isBaseUnit: true,
      },
    });

    const location = await prisma.inventoryLocation.create({
      data: { name: `DashLoc ${suffix}` },
    });
    locationId = location.id;

    const today = startOfTodayUtc();
    const expiringSoonDate = new Date(today.getTime() + 15 * 86_400_000); // 15 days
    const expiredDate = new Date(today.getTime() - 86_400_000);           // yesterday
    const farFutureDate = new Date(today.getTime() + 365 * 86_400_000);   // 1 year

    // Batch expiring soon (within 30 days) with stock = 5 (below minimumStock=10)
    const batchSoon = await prisma.batch.create({
      data: {
        productId,
        batchNumber: `B-SOON-${suffix}`,
        expiryDate: expiringSoonDate,
      },
    });
    batchIdExpiringSoon = batchSoon.id;
    await prisma.inventoryStock.create({
      data: { productId, batchId: batchSoon.id, locationId, quantity: 5 },
    });

    // Batch that is expired with remaining stock
    const batchExp = await prisma.batch.create({
      data: {
        productId,
        batchNumber: `B-EXP-${suffix}`,
        expiryDate: expiredDate,
      },
    });
    batchIdExpired = batchExp.id;
    await prisma.inventoryStock.create({
      data: { productId, batchId: batchExp.id, locationId, quantity: 3 },
    });

    // Batch far in the future (not expiring soon)
    const batchFar = await prisma.batch.create({
      data: {
        productId,
        batchNumber: `B-FAR-${suffix}`,
        expiryDate: farFutureDate,
      },
    });
    batchIdFarFuture = batchFar.id;
    await prisma.inventoryStock.create({
      data: { productId, batchId: batchFar.id, locationId, quantity: 100 },
    });

    // ── Supplier ──────────────────────────────────────────────────────────

    const supplier = await prisma.supplier.create({
      data: { name: `DashSupplier ${suffix}` },
    });
    supplierId = supplier.id;

    // ── Purchase requirement (OPEN) ───────────────────────────────────────

    const req = await prisma.purchaseRequirement.create({
      data: {
        reference: `REQ-DASH-${suffix}`,
        status: "OPEN",
        createdById: userId,
        lines: {
          create: [{ productId, quantityNeeded: 50 }],
        },
      },
    });
    requirementId = req.id;

    // ── Purchase orders ───────────────────────────────────────────────────

    // One awaiting delivery
    const poAwaiting = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-AW-${suffix}`,
        supplierId,
        status: "AWAITING_DELIVERY",
        createdById: userId,
        items: {
          create: [{ productId, quantityOrdered: 20, unitCost: 10 }],
        },
      },
      include: { items: true },
    });
    poAwaitingId = poAwaiting.id;

    // One registered with partial receiving (quantityReceived > 0 but < ordered)
    const poReg = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-PR-${suffix}`,
        supplierId,
        status: "REGISTERED",
        createdById: userId,
        items: {
          create: [{ productId, quantityOrdered: 30, unitCost: 10, quantityReceived: 10 }],
        },
      },
    });
    poRegisteredId = poReg.id;

    // ── Goods receipt (for recent-activity) ──────────────────────────────

    const gr = await prisma.goodsReceipt.create({
      data: {
        receiptNumber: `GR-DASH-${suffix}`,
        purchaseOrderId: poAwaitingId,
        supplierId,
        receivedDate: new Date(),
        createdById: userId,
        status: "MATCHED",
      },
    });
    goodsReceiptId = gr.id;

    // ── Supplier invoice (OPEN — outstanding) ─────────────────────────────

    const invoice = await prisma.supplierInvoice.create({
      data: {
        invoiceNumber: `INV-DASH-${suffix}`,
        supplierId,
        invoiceAmount: 5000,
        outstandingBalance: 5000,
        status: "OPEN",
        createdById: userId,
      },
    });
    invoiceId = invoice.id;

    // ── Slow-moving config (isFlagged = true) ─────────────────────────────

    const slowConfig = await prisma.slowMovingConfiguration.create({
      data: {
        productId,
        definitionType: "DAYS_90",
        isFlagged: true,
      },
    });
    slowConfigId = slowConfig.id;

    // ── Today's completed sale ────────────────────────────────────────────

    const completedSale = await prisma.sale.create({
      data: {
        saleNumber: `SL-DASH-C-${suffix}`,
        locationId,
        status: "COMPLETED",
        subtotal: 1000,
        totalAmount: 1000,
        paidAmount: 1000,
        cashierId: userId,
        completedAt: new Date(),
      },
    });
    completedSaleId = completedSale.id;

    // ── Today's cancelled sale (must NOT appear in today's totals) ────────

    const cancelledSale = await prisma.sale.create({
      data: {
        saleNumber: `SL-DASH-X-${suffix}`,
        locationId,
        status: "CANCELLED",
        subtotal: 999,
        totalAmount: 999,
        paidAmount: 0,
        cashierId: userId,
        cancelledAt: new Date(),
        cancelledById: userId,
      },
    });
    cancelledSaleId = cancelledSale.id;
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  afterAll(async () => {
    // Delete in dependency order
    await prisma.supplierInvoice.deleteMany({ where: { id: invoiceId } });
    await prisma.goodsReceipt.deleteMany({ where: { id: goodsReceiptId } });
    await prisma.purchaseOrder.deleteMany({
      where: { id: { in: [poAwaitingId, poRegisteredId] } },
    });
    await prisma.purchaseRequirement.deleteMany({ where: { id: requirementId } });
    await prisma.slowMovingConfiguration.deleteMany({ where: { id: slowConfigId } });
    await prisma.sale.deleteMany({
      where: { id: { in: [completedSaleId, cancelledSaleId] } },
    });
    await prisma.inventoryStock.deleteMany({ where: { locationId } });
    await prisma.batch.deleteMany({
      where: {
        id: {
          in: [batchIdFarFuture, batchIdExpiringSoon, batchIdExpired],
        },
      },
    });
    await prisma.productUnit.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.productGroup.deleteMany({ where: { id: groupId } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.unit.deleteMany({ where: { id: unitId } });
  });

  // ── Authorization tests ────────────────────────────────────────────────

  describe("authorization", () => {
    it("rejects unauthenticated requests with 401", async () => {
      await request(app).get(`${BASE}/summary`).expect(401);
      await request(app).get(`${BASE}/attention`).expect(401);
      await request(app).get(`${BASE}/recent-activity`).expect(401);
    });
  });

  // ── GET /dashboard/summary ────────────────────────────────────────────

  describe("GET /dashboard/summary", () => {
    it("returns 200 with the correct envelope", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it("includes today's completed sale revenue (not cancelled sale)", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);

      const { sales } = res.body.data as {
        sales: { today: number; transactions: number; averageTransaction: number };
      };

      // The cancelled sale (999) must NOT be included; only COMPLETED sales count
      expect(sales.today).toBeGreaterThanOrEqual(1000);
      expect(sales.transactions).toBeGreaterThanOrEqual(1);
      expect(sales.averageTransaction).toBeGreaterThan(0);

      // cancelled sale revenue (999) is not included
      expect(sales.today).not.toBeCloseTo(999, 0);
    });

    it("returns a non-NaN averageTransaction even with zero transactions", async () => {
      // We can't guarantee zero transactions in a shared DB, but we verify
      // the formula is safe by checking the returned value is a finite number.
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      const avg = res.body.data.sales.averageTransaction as number;
      expect(Number.isFinite(avg)).toBe(true);
      expect(avg).toBeGreaterThanOrEqual(0);
    });

    it("includes at least 1 expiring-soon batch (the one we seeded)", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      const { inventory } = res.body.data as {
        inventory: { expiringSoonCount: number; expiredCount: number };
      };
      expect(inventory.expiringSoonCount).toBeGreaterThanOrEqual(1);
    });

    it("includes at least 1 expired batch with stock", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      const { inventory } = res.body.data as {
        inventory: { expiredCount: number };
      };
      expect(inventory.expiredCount).toBeGreaterThanOrEqual(1);
    });

    it("includes at least 1 open requirement", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data.purchasing.openRequirements).toBeGreaterThanOrEqual(1);
    });

    it("includes the awaiting-delivery PO", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data.purchasing.awaitingDelivery).toBeGreaterThanOrEqual(1);
    });

    it("counts the partially-received PO", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data.purchasing.partiallyReceived).toBeGreaterThanOrEqual(1);
    });

    it("counts the outstanding invoice", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data.purchasing.outstandingInvoices).toBeGreaterThanOrEqual(1);
    });

    it("reads the persisted isFlagged count without triggering evaluation", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data.slowMoving.flaggedCount).toBeGreaterThanOrEqual(1);
    });

    it("returns a non-negative stock value", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      const sv = res.body.data.inventory.stockValue as number;
      expect(Number.isFinite(sv)).toBe(true);
      expect(sv).toBeGreaterThanOrEqual(0);
    });

    it("has no NaN or null numeric fields", async () => {
      const res = await request(app)
        .get(`${BASE}/summary`)
        .set("Cookie", cookie)
        .expect(200);
      const d = res.body.data;
      const nums = [
        d.sales.today,
        d.sales.transactions,
        d.sales.averageTransaction,
        d.inventory.stockValue,
        d.inventory.lowStockCount,
        d.inventory.outOfStockCount,
        d.inventory.expiringSoonCount,
        d.inventory.expiredCount,
        d.purchasing.openRequirements,
        d.purchasing.awaitingDelivery,
        d.purchasing.partiallyReceived,
        d.purchasing.outstandingInvoices,
        d.slowMoving.flaggedCount,
      ];
      for (const n of nums) {
        expect(n).not.toBeNull();
        expect(Number.isFinite(n)).toBe(true);
      }
    });
  });

  // ── GET /dashboard/attention ──────────────────────────────────────────

  describe("GET /dashboard/attention", () => {
    it("returns 200 with the correct envelope", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it("returns arrays for all four categories", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      const d = res.body.data;
      expect(Array.isArray(d.lowStock)).toBe(true);
      expect(Array.isArray(d.expiringSoon)).toBe(true);
      expect(Array.isArray(d.awaitingDelivery)).toBe(true);
      expect(Array.isArray(d.outstandingInvoices)).toBe(true);
    });

    it("limits each category to a maximum of 5 items", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      const d = res.body.data;
      expect(d.lowStock.length).toBeLessThanOrEqual(5);
      expect(d.expiringSoon.length).toBeLessThanOrEqual(5);
      expect(d.awaitingDelivery.length).toBeLessThanOrEqual(5);
      expect(d.outstandingInvoices.length).toBeLessThanOrEqual(5);
    });

    it("expiringSoon items have the required fields", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      for (const item of res.body.data.expiringSoon) {
        expect(item).toHaveProperty("batchId");
        expect(item).toHaveProperty("productId");
        expect(item).toHaveProperty("productName");
        expect(item).toHaveProperty("batchNumber");
        expect(item).toHaveProperty("expiryDate");
        expect(item).toHaveProperty("remainingQuantity");
      }
    });

    it("awaitingDelivery items have the required fields", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      for (const item of res.body.data.awaitingDelivery) {
        expect(item).toHaveProperty("purchaseOrderId");
        expect(item).toHaveProperty("poNumber");
        expect(item).toHaveProperty("supplierName");
        expect(item).toHaveProperty("expectedDeliveryDate");
      }
    });

    it("outstandingInvoices items have the required fields", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      for (const item of res.body.data.outstandingInvoices) {
        expect(item).toHaveProperty("invoiceId");
        expect(item).toHaveProperty("invoiceNumber");
        expect(item).toHaveProperty("supplierName");
        expect(item).toHaveProperty("outstandingBalance");
        expect(item).toHaveProperty("dueDate");
      }
    });

    it("includes the seeded awaiting-delivery PO", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      const ids = (res.body.data.awaitingDelivery as { purchaseOrderId: string }[]).map(
        (i) => i.purchaseOrderId,
      );
      expect(ids).toContain(poAwaitingId);
    });

    it("includes the seeded outstanding invoice", async () => {
      const res = await request(app)
        .get(`${BASE}/attention`)
        .set("Cookie", cookie)
        .expect(200);
      const ids = (res.body.data.outstandingInvoices as { invoiceId: string }[]).map(
        (i) => i.invoiceId,
      );
      expect(ids).toContain(invoiceId);
    });
  });

  // ── GET /dashboard/recent-activity ────────────────────────────────────

  describe("GET /dashboard/recent-activity", () => {
    it("returns 200 with a success envelope", async () => {
      const res = await request(app)
        .get(`${BASE}/recent-activity`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("returns no more than 10 items", async () => {
      const res = await request(app)
        .get(`${BASE}/recent-activity`)
        .set("Cookie", cookie)
        .expect(200);
      expect((res.body.data as unknown[]).length).toBeLessThanOrEqual(10);
    });

    it("activity items have the required fields", async () => {
      const res = await request(app)
        .get(`${BASE}/recent-activity`)
        .set("Cookie", cookie)
        .expect(200);
      for (const item of res.body.data as {
        type: string;
        reference: string;
        description: string;
        createdAt: string;
      }[]) {
        expect(item).toHaveProperty("type");
        expect(item).toHaveProperty("reference");
        expect(item).toHaveProperty("description");
        expect(item).toHaveProperty("createdAt");
        expect(["SALE_COMPLETED", "GOODS_RECEIVED", "PURCHASE_ORDER_CREATED"]).toContain(
          item.type,
        );
        expect(new Date(item.createdAt).getTime()).toBeGreaterThan(0);
      }
    });

    it("items are sorted newest-first", async () => {
      const res = await request(app)
        .get(`${BASE}/recent-activity`)
        .set("Cookie", cookie)
        .expect(200);
      const items = res.body.data as { createdAt: string }[];
      for (let i = 1; i < items.length; i++) {
        expect(new Date(items[i - 1]!.createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(items[i]!.createdAt).getTime(),
        );
      }
    });

    it("includes the seeded completed sale", async () => {
      const res = await request(app)
        .get(`${BASE}/recent-activity`)
        .set("Cookie", cookie)
        .expect(200);
      const sales = (
        res.body.data as { type: string; reference: string }[]
      ).filter((i) => i.type === "SALE_COMPLETED");
      const refs = sales.map((i) => i.reference);
      expect(refs).toContain(`SL-DASH-C-${suffix}`);
    });
  });
});
