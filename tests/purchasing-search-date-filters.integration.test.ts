import request from "supertest";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

/**
 * Purchasing search + date filtering for purchase orders, goods receipts and
 * supplier invoices.
 *
 * These end-to-end tests make many round-trips to a remote database; give them room.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BASE = "/api/v1/purchasing";
const FUTURE_EXPIRY = "2032-06-30";
const DAY_MS = 86_400_000;

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
}

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

// ── deterministic UTC calendar boundaries (mirror the implementation) ────────
const NOW = new Date();
const TODAY_START = new Date(
  Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()),
);
const DOW = TODAY_START.getUTCDay();
const MONDAY_START = new Date(TODAY_START.getTime() - ((DOW + 6) % 7) * DAY_MS);
const MONTH_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
function atHour(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type ApiPo = {
  id: string;
  poNumber: string;
  supplierId: string;
  status: string;
  items: Array<{ id: string; productId: string }>;
};

describe("purchasing: search and date filters", () => {
  let cookie: string;
  let userId = "";
  let groupId = "";
  let unitId = "";
  let locationId = "";
  let pAlpha = "";
  let pBeta = "";

  const createdProductIds: string[] = [];
  const createdPoIds: string[] = [];
  const createdGrIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdSupplierIds: string[] = [];

  beforeAll(async () => {
    const suffix = uniqueSuffix();
    const email = `search-filters.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Search Filters Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    const group = await prisma.productGroup.create({
      data: { name: `Search Filters Group ${suffix}` },
    });
    groupId = group.id;

    const unit = await prisma.unit.create({
      data: { name: `Search Filters Piece ${suffix}`, symbol: `SF-${suffix.slice(-4)}` },
    });
    unitId = unit.id;

    const [alpha, beta] = await Promise.all([
      prisma.product.create({
        data: {
          name: `Amoxicillin Searchable ${suffix}`,
          sku: `SF-A-${suffix}`,
          productGroupId: group.id,
          units: { create: { unitId: unit.id, conversionFactor: 1, isBaseUnit: true } },
        },
        select: { id: true },
      }),
      prisma.product.create({
        data: {
          name: `Ibuprofen Searchable ${suffix}`,
          sku: `SF-B-${suffix}`,
          productGroupId: group.id,
          units: { create: { unitId: unit.id, conversionFactor: 1, isBaseUnit: true } },
        },
        select: { id: true },
      }),
    ]);
    pAlpha = alpha.id;
    pBeta = beta.id;
    createdProductIds.push(pAlpha, pBeta);

    const location = await prisma.inventoryLocation.create({
      data: { name: `Search Filters Store ${suffix}` },
    });
    locationId = location.id;
  });

  afterEach(async () => {
    if (createdInvoiceIds.length) {
      await prisma.supplierInvoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
      createdInvoiceIds.length = 0;
    }
    if (createdGrIds.length) {
      await prisma.goodsReceipt.deleteMany({ where: { id: { in: createdGrIds } } });
      createdGrIds.length = 0;
    }
    if (createdPoIds.length) {
      await prisma.purchaseOrder.deleteMany({ where: { id: { in: createdPoIds } } });
      createdPoIds.length = 0;
    }
    if (createdSupplierIds.length) {
      await prisma.supplier.deleteMany({ where: { id: { in: createdSupplierIds } } });
      createdSupplierIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.productUnit.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.unit.deleteMany({ where: { id: unitId } });
    await prisma.productGroup.deleteMany({ where: { id: groupId } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function makeSupplier(label: string): Promise<string> {
    const supplier = await prisma.supplier.create({
      data: { name: `${label} ${uniqueSuffix()}` },
    });
    createdSupplierIds.push(supplier.id);
    return supplier.id;
  }

  async function createPo(
    supplierId: string,
    productIds: string[],
  ): Promise<ApiPo> {
    const res = await request(app)
      .post(`${BASE}/purchase-orders`)
      .set("Cookie", cookie)
      .send({
        supplierId,
        items: productIds.map((productId) => ({
          productId,
          quantityOrdered: 10,
          unitCost: 5,
        })),
      })
      .expect(201);
    const po = res.body.data as ApiPo;
    createdPoIds.push(po.id);
    return po;
  }

  async function setPoOrderDate(poId: string, orderDate: Date): Promise<void> {
    await prisma.purchaseOrder.update({ where: { id: poId }, data: { orderDate } });
  }

  async function createGr(
    po: ApiPo,
    lines: Array<{ itemId: string; qty: number }>,
    receivedDate?: Date,
  ): Promise<string> {
    const res = await request(app)
      .post(`${BASE}/purchase-orders/${po.id}/goods-receipts`)
      .set("Cookie", cookie)
      .send({
        ...(receivedDate ? { receivedDate: receivedDate.toISOString() } : {}),
        items: lines.map((line) => ({
          purchaseOrderItemId: line.itemId,
          locationId,
          deliveredQty: line.qty,
          actualQty: line.qty,
          batchNumber: `SF-${uniqueSuffix()}`,
          expiryDate: FUTURE_EXPIRY,
        })),
      })
      .expect(201);
    const id = res.body.data.id as string;
    createdGrIds.push(id);
    return id;
  }

  async function createInvoice(
    supplierId: string,
    invoiceNumber: string,
    goodsAmount: number,
    options: { invoiceDate?: Date; status?: "OPEN" | "PAID" } = {},
  ): Promise<string> {
    const res = await request(app)
      .post(`${BASE}/supplier-invoices`)
      .set("Cookie", cookie)
      .send({
        supplierId,
        invoiceNumber,
        goodsAmount,
        ...(options.invoiceDate ? { invoiceDate: options.invoiceDate.toISOString() } : {}),
      })
      .expect(201);
    const id = res.body.data.id as string;
    createdInvoiceIds.push(id);
    if (options.status && options.status !== "OPEN") {
      await prisma.supplierInvoice.update({ where: { id }, data: { status: options.status } });
    }
    return id;
  }

  function ids(body: { data: Array<{ id: string }> }): string[] {
    return body.data.map((row) => row.id);
  }

  // ── Purchase orders: search ────────────────────────────────────────────────

  describe("purchase orders: search", () => {
    it("searches by partial purchase order number", async () => {
      const supplier = await makeSupplier("PO Search Supplier");
      const po = await createPo(supplier, [pAlpha]);
      const fragment = po.poNumber.replace("PO-", "").slice(0, 5);

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: fragment, limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(po.id);
    });

    it("searches by partial supplier name", async () => {
      const supplier = await makeSupplier("Distinctive Vendor");
      const supplierName = (
        await prisma.supplier.findUnique({ where: { id: supplier }, select: { name: true } })
      )!.name;
      const po = await createPo(supplier, [pAlpha]);

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "Distinctive Vendor", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(supplierName).toContain("Distinctive Vendor");
      expect(ids(res.body)).toContain(po.id);
    });

    it("searches by partial medicine/product name", async () => {
      const supplier = await makeSupplier("PO Product Supplier");
      const po = await createPo(supplier, [pAlpha]);

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "Amoxicillin Searchable", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(po.id);
    });

    it("returns a PO once even when multiple line items match", async () => {
      const supplier = await makeSupplier("PO Dup Supplier");
      // Two line items on the same order, both matching the product search.
      const po = await createPo(supplier, [pAlpha, pAlpha]);

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "Amoxicillin Searchable", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      const matching = res.body.data.filter((row: { id: string }) => row.id === po.id);
      expect(matching).toHaveLength(1);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it("composes search with the existing status filter", async () => {
      const supplier = await makeSupplier("PO Status Supplier");
      const po = await createPo(supplier, [pBeta]);

      const awaiting = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "Ibuprofen Searchable", status: "AWAITING_DELIVERY", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(awaiting.body)).toContain(po.id);

      const received = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "Ibuprofen Searchable", status: "RECEIVED", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(received.body)).not.toContain(po.id);
    });

    it("trims surrounding whitespace and ignores a blank search", async () => {
      const supplier = await makeSupplier("PO Trim Supplier");
      const po = await createPo(supplier, [pAlpha]);

      const padded = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "  Amoxicillin Searchable  ", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(padded.body)).toContain(po.id);

      const blank = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: "   ", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(blank.body.success).toBe(true);
      expect(ids(blank.body)).toContain(po.id);
    });

    it("returns an empty result set for a non-matching search", async () => {
      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ search: `no-match-${uniqueSuffix()}` })
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });
  });

  // ── Purchase orders: date filtering ────────────────────────────────────────

  describe("purchase orders: date filtering", () => {
    it("datePreset=today filters on orderDate", async () => {
      const supplier = await makeSupplier("PO Today Supplier");
      const poToday = await createPo(supplier, [pAlpha]);
      const poOld = await createPo(supplier, [pBeta]);
      await setPoOrderDate(poToday.id, atHour(TODAY_START, 12));
      await setPoOrderDate(poOld.id, atHour(addDays(TODAY_START, -40), 12));

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, datePreset: "today", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(poToday.id);
      expect(ids(res.body)).not.toContain(poOld.id);
      expect(res.body.meta.total).toBe(1);
    });

    it("datePreset=this_week spans Monday..Sunday", async () => {
      const supplier = await makeSupplier("PO Week Supplier");
      const poThisWeek = await createPo(supplier, [pAlpha]);
      const poPrevWeek = await createPo(supplier, [pBeta]);
      await setPoOrderDate(poThisWeek.id, atHour(addDays(MONDAY_START, 2), 12));
      await setPoOrderDate(poPrevWeek.id, atHour(addDays(MONDAY_START, -2), 12));

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, datePreset: "this_week", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(poThisWeek.id);
      expect(ids(res.body)).not.toContain(poPrevWeek.id);
    });

    it("datePreset=this_month spans the calendar month", async () => {
      const supplier = await makeSupplier("PO Month Supplier");
      const poThisMonth = await createPo(supplier, [pAlpha]);
      const poPrevMonth = await createPo(supplier, [pBeta]);
      await setPoOrderDate(poThisMonth.id, atHour(MONTH_START, 12));
      await setPoOrderDate(poPrevMonth.id, atHour(addDays(MONTH_START, -1), 12));

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, datePreset: "this_month", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(poThisMonth.id);
      expect(ids(res.body)).not.toContain(poPrevMonth.id);
    });

    it("includes records on the exact preset boundaries", async () => {
      const supplier = await makeSupplier("PO Boundary Supplier");
      const atStart = await createPo(supplier, [pAlpha]);
      const nextDay = await createPo(supplier, [pBeta]);
      await setPoOrderDate(atStart.id, TODAY_START);
      await setPoOrderDate(nextDay.id, addDays(TODAY_START, 1));

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, datePreset: "today", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(atStart.id);
      expect(ids(res.body)).not.toContain(nextDay.id);
    });

    it("supports inclusive custom calendar ranges", async () => {
      const supplier = await makeSupplier("PO Custom Supplier");
      const from = addDays(TODAY_START, -5);
      const to = addDays(TODAY_START, -2);
      const onFrom = await createPo(supplier, [pAlpha]);
      const onTo = await createPo(supplier, [pAlpha]);
      const before = await createPo(supplier, [pBeta]);
      const after = await createPo(supplier, [pBeta]);
      await setPoOrderDate(onFrom.id, from);
      await setPoOrderDate(onTo.id, atHour(to, 20));
      await setPoOrderDate(before.id, atHour(addDays(from, -1), 12));
      await setPoOrderDate(after.id, atHour(addDays(to, 1), 12));

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, dateFrom: isoDay(from), dateTo: isoDay(to), limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      const returned = ids(res.body);
      expect(returned).toContain(onFrom.id);
      expect(returned).toContain(onTo.id);
      expect(returned).not.toContain(before.id);
      expect(returned).not.toContain(after.id);
    });

    it("supports open-ended custom bounds", async () => {
      const supplier = await makeSupplier("PO Open Supplier");
      const cutoff = addDays(TODAY_START, -10);
      const older = await createPo(supplier, [pAlpha]);
      const newer = await createPo(supplier, [pBeta]);
      await setPoOrderDate(older.id, atHour(addDays(cutoff, -3), 12));
      await setPoOrderDate(newer.id, atHour(addDays(cutoff, 3), 12));

      const onlyFrom = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, dateFrom: isoDay(cutoff), limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(onlyFrom.body)).toContain(newer.id);
      expect(ids(onlyFrom.body)).not.toContain(older.id);

      const onlyTo = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, dateTo: isoDay(cutoff), limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(onlyTo.body)).toContain(older.id);
      expect(ids(onlyTo.body)).not.toContain(newer.id);
    });

    it("composes search and date filters", async () => {
      const supplier = await makeSupplier("PO Search Date Supplier");
      const poToday = await createPo(supplier, [pAlpha]);
      const poOld = await createPo(supplier, [pAlpha]);
      await setPoOrderDate(poToday.id, atHour(TODAY_START, 12));
      await setPoOrderDate(poOld.id, atHour(addDays(TODAY_START, -40), 12));

      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({
          supplierId: supplier,
          search: "Amoxicillin Searchable",
          datePreset: "today",
          limit: 100,
        })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(poToday.id);
      expect(ids(res.body)).not.toContain(poOld.id);
    });

    it("keeps pagination and total aligned with the filtered dataset", async () => {
      const supplier = await makeSupplier("PO Pagination Supplier");
      await createPo(supplier, [pAlpha]);
      await createPo(supplier, [pAlpha]);
      await createPo(supplier, [pAlpha]);

      const page1 = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, search: "Amoxicillin Searchable", limit: 2, page: 1 })
        .set("Cookie", cookie)
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.total).toBe(3);
      expect(page1.body.meta.totalPages).toBe(2);

      const page2 = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ supplierId: supplier, search: "Amoxicillin Searchable", limit: 2, page: 2 })
        .set("Cookie", cookie)
        .expect(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.meta.total).toBe(3);
    });

    it("rejects an inverted custom range", async () => {
      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ dateFrom: "2026-10-12", dateTo: "2026-10-01" })
        .set("Cookie", cookie)
        .expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a malformed date", async () => {
      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ dateFrom: "not-a-date" })
        .set("Cookie", cookie)
        .expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a preset combined with custom bounds", async () => {
      const res = await request(app)
        .get(`${BASE}/purchase-orders`)
        .query({ datePreset: "today", dateFrom: "2026-10-01" })
        .set("Cookie", cookie)
        .expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── Goods receipts ─────────────────────────────────────────────────────────

  describe("goods receipts: search and date filtering", () => {
    it("searches by partial receipt number", async () => {
      const supplier = await makeSupplier("GR Number Supplier");
      const po = await createPo(supplier, [pAlpha]);
      const grId = await createGr(po, [{ itemId: po.items[0].id, qty: 10 }]);
      const gr = await prisma.goodsReceipt.findUnique({ where: { id: grId } });
      const fragment = gr!.receiptNumber.replace("GR-", "").slice(0, 5);

      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ search: fragment, limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(grId);
    });

    it("searches by supplier name", async () => {
      const supplier = await makeSupplier("GR Distinctive Supplier");
      const po = await createPo(supplier, [pAlpha]);
      const grId = await createGr(po, [{ itemId: po.items[0].id, qty: 10 }]);

      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ search: "GR Distinctive Supplier", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(grId);
    });

    it("searches by received medicine/product name", async () => {
      const supplier = await makeSupplier("GR Product Supplier");
      const po = await createPo(supplier, [pBeta]);
      const grId = await createGr(po, [{ itemId: po.items[0].id, qty: 10 }]);

      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ search: "Ibuprofen Searchable", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(grId);
    });

    it("returns a receipt once even when multiple items match", async () => {
      const supplier = await makeSupplier("GR Dup Supplier");
      const po = await createPo(supplier, [pAlpha, pAlpha]);
      const grId = await createGr(po, [
        { itemId: po.items[0].id, qty: 5 },
        { itemId: po.items[1].id, qty: 5 },
      ]);

      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ search: "Amoxicillin Searchable", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      const matching = res.body.data.filter((row: { id: string }) => row.id === grId);
      expect(matching).toHaveLength(1);
    });

    it("date presets use the receipt date, not the linked PO date", async () => {
      const supplier = await makeSupplier("GR Date Supplier");
      const po = await createPo(supplier, [pAlpha]);

      // The PO is dated today but the receipt is old: NOT included in today.
      await setPoOrderDate(po.id, atHour(TODAY_START, 12));
      const oldReceipt = await createGr(
        po,
        [{ itemId: po.items[0].id, qty: 10 }],
        atHour(addDays(TODAY_START, -40), 9),
      );

      // A second PO dated long ago but received today: included in today.
      const poOld = await createPo(supplier, [pBeta]);
      await setPoOrderDate(poOld.id, atHour(addDays(TODAY_START, -60), 12));
      const recentReceipt = await createGr(
        poOld,
        [{ itemId: poOld.items[0].id, qty: 10 }],
        atHour(TODAY_START, 9),
      );

      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ supplierId: supplier, datePreset: "today", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(recentReceipt);
      expect(ids(res.body)).not.toContain(oldReceipt);
    });

    it("handles receipts on the exact date boundary", async () => {
      const supplier = await makeSupplier("GR Boundary Supplier");
      const po = await createPo(supplier, [pAlpha]);
      const onBoundary = await createGr(po, [{ itemId: po.items[0].id, qty: 5 }], TODAY_START);
      const poTomorrow = await createPo(supplier, [pBeta]);
      const tomorrow = await createGr(
        poTomorrow,
        [{ itemId: poTomorrow.items[0].id, qty: 5 }],
        addDays(TODAY_START, 1),
      );

      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ supplierId: supplier, datePreset: "today", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(onBoundary);
      expect(ids(res.body)).not.toContain(tomorrow);
    });

    it("composes search, status and date filters", async () => {
      const supplier = await makeSupplier("GR Compose Supplier");
      const po = await createPo(supplier, [pAlpha]);
      const grId = await createGr(po, [{ itemId: po.items[0].id, qty: 10 }], atHour(TODAY_START, 9));

      const match = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({
          supplierId: supplier,
          search: "Amoxicillin Searchable",
          status: "MATCHED",
          datePreset: "today",
          limit: 100,
        })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(match.body)).toContain(grId);

      const noStatus = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({
          supplierId: supplier,
          search: "Amoxicillin Searchable",
          status: "DISCREPANCY",
          datePreset: "today",
          limit: 100,
        })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(noStatus.body)).not.toContain(grId);
    });

    it("keeps pagination and total aligned with the filtered dataset", async () => {
      const supplier = await makeSupplier("GR Pagination Supplier");
      for (let i = 0; i < 3; i += 1) {
        const po = await createPo(supplier, [pAlpha]);
        await createGr(po, [{ itemId: po.items[0].id, qty: 5 }], atHour(TODAY_START, 9));
      }

      const page1 = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ supplierId: supplier, datePreset: "today", limit: 2, page: 1 })
        .set("Cookie", cookie)
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.total).toBe(3);
      expect(page1.body.meta.totalPages).toBe(2);

      const page2 = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ supplierId: supplier, datePreset: "today", limit: 2, page: 2 })
        .set("Cookie", cookie)
        .expect(200);
      expect(page2.body.data).toHaveLength(1);
    });

    it("rejects a preset combined with custom bounds", async () => {
      const res = await request(app)
        .get(`${BASE}/goods-receipts`)
        .query({ datePreset: "today", dateTo: "2026-10-01" })
        .set("Cookie", cookie)
        .expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── Supplier invoices ──────────────────────────────────────────────────────

  describe("supplier invoices: search and date filtering", () => {
    it("preserves the existing invoice-number search", async () => {
      const supplier = await makeSupplier("SI Number Supplier");
      const number = `INV-SF-${uniqueSuffix()}`;
      const invoiceId = await createInvoice(supplier, number, 100);

      const res = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ search: "INV-SF", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(invoiceId);
    });

    it("preserves the existing supplier-name search", async () => {
      const supplier = await makeSupplier("SI Distinctive Supplier");
      const invoiceId = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 100);

      const res = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ search: "SI Distinctive Supplier", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(invoiceId);
    });

    it("still requires an invoice number", async () => {
      const supplier = await makeSupplier("SI Required Supplier");
      const res = await request(app)
        .post(`${BASE}/supplier-invoices`)
        .set("Cookie", cookie)
        .send({ supplierId: supplier, goodsAmount: 50 })
        .expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("datePreset=today filters on invoiceDate", async () => {
      const supplier = await makeSupplier("SI Date Supplier");
      const todayInvoice = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 100, {
        invoiceDate: atHour(TODAY_START, 12),
      });
      const oldInvoice = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 100, {
        invoiceDate: atHour(addDays(TODAY_START, -40), 12),
      });

      const res = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ supplierId: supplier, datePreset: "today", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(todayInvoice);
      expect(ids(res.body)).not.toContain(oldInvoice);
    });

    it("supports this_week and this_month presets", async () => {
      const supplier = await makeSupplier("SI Preset Supplier");
      const inWeek = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 10, {
        invoiceDate: atHour(addDays(MONDAY_START, 1), 12),
      });
      const prevWeek = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 10, {
        invoiceDate: atHour(addDays(MONDAY_START, -2), 12),
      });
      const inMonth = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 10, {
        invoiceDate: atHour(MONTH_START, 12),
      });

      const week = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ supplierId: supplier, datePreset: "this_week", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(week.body)).toContain(inWeek);
      expect(ids(week.body)).not.toContain(prevWeek);

      const month = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ supplierId: supplier, datePreset: "this_month", limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(month.body)).toContain(inMonth);
    });

    it("supports inclusive custom ranges and validates them", async () => {
      const supplier = await makeSupplier("SI Custom Supplier");
      const from = addDays(TODAY_START, -5);
      const to = addDays(TODAY_START, -2);
      const inside = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 10, {
        invoiceDate: atHour(to, 20),
      });
      const outside = await createInvoice(supplier, `INV-${uniqueSuffix()}`, 10, {
        invoiceDate: atHour(addDays(to, 1), 12),
      });

      const res = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ supplierId: supplier, dateFrom: isoDay(from), dateTo: isoDay(to), limit: 100 })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(res.body)).toContain(inside);
      expect(ids(res.body)).not.toContain(outside);

      const invalid = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ dateFrom: "2026-10-12", dateTo: "2026-10-01" })
        .set("Cookie", cookie)
        .expect(422);
      expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("composes search, status and date filters", async () => {
      const supplier = await makeSupplier("SI Compose Supplier");
      const number = `INV-COMPOSE-${uniqueSuffix()}`;
      const openId = await createInvoice(supplier, number, 10, {
        invoiceDate: atHour(TODAY_START, 9),
      });
      const paidId = await createInvoice(supplier, `INV-PAID-${uniqueSuffix()}`, 10, {
        invoiceDate: atHour(TODAY_START, 9),
        status: "PAID",
      });

      const openOnly = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({
          supplierId: supplier,
          search: "INV-",
          status: "OPEN",
          datePreset: "today",
          limit: 100,
        })
        .set("Cookie", cookie)
        .expect(200);
      expect(ids(openOnly.body)).toContain(openId);
      expect(ids(openOnly.body)).not.toContain(paidId);
    });

    it("keeps pagination and total aligned with the filtered dataset", async () => {
      const supplier = await makeSupplier("SI Pagination Supplier");
      for (let i = 0; i < 3; i += 1) {
        await createInvoice(supplier, `INV-PAGE-${uniqueSuffix()}`, 10, {
          invoiceDate: atHour(TODAY_START, 9),
        });
      }

      const page1 = await request(app)
        .get(`${BASE}/supplier-invoices`)
        .query({ supplierId: supplier, datePreset: "today", limit: 2, page: 1 })
        .set("Cookie", cookie)
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.total).toBe(3);
      expect(page1.body.meta.totalPages).toBe(2);
    });
  });
});
