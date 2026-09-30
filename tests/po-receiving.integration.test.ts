import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

/**
 * Purchase order -> manual goods receipt / delivery workflow.
 *
 * Covers: one-product and multi-product POs, partial and repeated deliveries,
 * selective (subset) receiving, item/pO receiving state, supplier -> receivable
 * PO selection, receiving-item filtering, over-receiving validation, empty
 * receipts, multi-batch deliveries, accepted shortages and concurrency.
 *
 * These end-to-end tests make many round-trips to a remote database; give them room.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BASE = "/api/v1/purchasing";
const FUTURE_EXPIRY = "2032-06-30";

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
}

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

type ApiItem = {
  id: string;
  productId: string;
  product?: { id: string; name: string; sku: string };
  quantityOrdered: string | number;
  quantityReceived: string | number;
  quantityShort: string | number;
  quantityRemaining?: number;
  quantityPreviouslyReceived?: string | number;
};

type ApiPo = {
  id: string;
  supplierId: string;
  status: string;
  items: ApiItem[];
  receivingSummary: {
    orderedQuantity: number;
    receivedQuantity: number;
    shortQuantity: number;
    remainingQuantity: number;
  };
};

describe("purchasing: purchase order receiving lifecycle", () => {
  let cookie: string;
  let userId: string;
  let groupId: string;
  let unitId: string;
  let locationId: string;
  let supplierA: string;
  let supplierSel: string;
  const productIds: string[] = [];
  const supplierIds: string[] = [];

  let pA = "";
  let pB = "";
  let pC = "";
  let pD = "";

  beforeAll(async () => {
    const suffix = uniqueSuffix();
    const email = `po-receiving.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Receiving Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    const group = await prisma.productGroup.create({
      data: { name: `Receiving Group ${suffix}` },
    });
    groupId = group.id;

    const unit = await prisma.unit.create({
      data: { name: `Receiving Piece ${suffix}`, symbol: `RC-${suffix.slice(-4)}` },
    });
    unitId = unit.id;

    const products = await Promise.all(
      ["A", "B", "C", "D"].map((tag) =>
        prisma.product.create({
          data: {
            name: `Receiving Product ${tag} ${suffix}`,
            sku: `RCV-${tag}-${suffix}`,
            productGroupId: group.id,
            units: {
              create: { unitId: unit.id, conversionFactor: 1, isBaseUnit: true },
            },
          },
          select: { id: true },
        }),
      ),
    );
    [pA, pB, pC, pD] = products.map((p) => p.id);
    productIds.push(pA, pB, pC, pD);

    const location = await prisma.inventoryLocation.create({
      data: { name: `Receiving Store ${suffix}` },
    });
    locationId = location.id;

    const [a, sel] = await Promise.all([
      prisma.supplier.create({ data: { name: `Receiving Supplier A ${suffix}` } }),
      prisma.supplier.create({ data: { name: `Receiving Supplier Sel ${suffix}` } }),
    ]);
    supplierA = a.id;
    supplierSel = sel.id;
    supplierIds.push(supplierA, supplierSel);
  });

  afterAll(async () => {
    await prisma.purchaseRequirementAllocation.deleteMany({
      where: { purchaseOrderItem: { purchaseOrder: { supplierId: { in: supplierIds } } } },
    });
    await prisma.goodsReceiptItem.deleteMany({
      where: { purchaseOrderItem: { purchaseOrder: { supplierId: { in: supplierIds } } } },
    });
    await prisma.goodsReceipt.deleteMany({ where: { supplierId: { in: supplierIds } } });
    await prisma.purchaseOrderItem.deleteMany({
      where: { purchaseOrder: { supplierId: { in: supplierIds } } },
    });
    await prisma.purchaseOrder.deleteMany({ where: { supplierId: { in: supplierIds } } });
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.unit.deleteMany({ where: { id: unitId } });
    await prisma.productGroup.deleteMany({ where: { id: groupId } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function createPo(
    supplierId: string,
    items: Array<{ productId: string; qty: number }>,
  ): Promise<ApiPo> {
    const res = await request(app)
      .post(`${BASE}/purchase-orders`)
      .set("Cookie", cookie)
      .send({
        supplierId,
        items: items.map((i) => ({
          productId: i.productId,
          quantityOrdered: i.qty,
          unitCost: 10,
        })),
      })
      .expect(201);
    return res.body.data as ApiPo;
  }

  function itemOf(po: ApiPo, productId: string): ApiItem {
    const item = po.items.find((i) => i.productId === productId);
    if (!item) throw new Error(`PO ${po.id} has no item for product ${productId}`);
    return item;
  }

  function createReceipt(
    poId: string,
    lines: Array<{ itemId: string; qty: number; batch?: string }>,
  ) {
    return request(app)
      .post(`${BASE}/purchase-orders/${poId}/goods-receipts`)
      .set("Cookie", cookie)
      .send({
        items: lines.map((line) => ({
          purchaseOrderItemId: line.itemId,
          locationId,
          deliveredQty: line.qty,
          actualQty: line.qty,
          batchNumber: line.batch ?? `RCV-${uniqueSuffix()}`,
          expiryDate: FUTURE_EXPIRY,
        })),
      });
  }

  function resolveReceipt(receiptId: string) {
    return request(app)
      .patch(`${BASE}/goods-receipts/${receiptId}/resolve`)
      .set("Cookie", cookie)
      .send({ discrepancyNote: "Partial delivery accepted" });
  }

  function confirmReceipt(receiptId: string) {
    return request(app)
      .post(`${BASE}/goods-receipts/${receiptId}/confirm`)
      .set("Cookie", cookie);
  }

  /** Create + resolve (if needed) + confirm a delivery in one go. */
  async function receive(
    poId: string,
    lines: Array<{ itemId: string; qty: number; batch?: string }>,
  ) {
    const created = await createReceipt(poId, lines).expect(201);
    const receiptId = created.body.data.id as string;
    if (created.body.data.status === "DISCREPANCY") {
      await resolveReceipt(receiptId).expect(200);
    }
    await confirmReceipt(receiptId).expect(200);
    return receiptId;
  }

  async function getPo(poId: string, query = ""): Promise<ApiPo> {
    const res = await request(app)
      .get(`${BASE}/purchase-orders/${poId}${query}`)
      .set("Cookie", cookie)
      .expect(200);
    return res.body.data as ApiPo;
  }

  // ── single product ───────────────────────────────────────────────────────

  it("A1: nothing received -> AWAITING_DELIVERY, remaining = ordered", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 40 }]);
    const detail = await getPo(po.id);
    expect(detail.status).toBe("AWAITING_DELIVERY");
    const item = itemOf(detail, pA);
    expect(Number(item.quantityReceived)).toBe(0);
    expect(item.quantityRemaining).toBe(40);
    expect(detail.receivingSummary.remainingQuantity).toBe(40);
  });

  it("A2: partial receipt -> PARTIALLY_RECEIVED", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 40 }]);
    await receive(po.id, [{ itemId: itemOf(po, pA).id, qty: 20 }]);

    const detail = await getPo(po.id);
    expect(detail.status).toBe("PARTIALLY_RECEIVED");
    const item = itemOf(detail, pA);
    expect(Number(item.quantityReceived)).toBe(20);
    expect(Number(item.quantityShort)).toBe(0);
    expect(item.quantityRemaining).toBe(20);
  });

  it("A3: full receipt -> RECEIVED", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 40 }]);
    await receive(po.id, [{ itemId: itemOf(po, pA).id, qty: 40 }]);

    const detail = await getPo(po.id);
    expect(detail.status).toBe("RECEIVED");
    const item = itemOf(detail, pA);
    expect(Number(item.quantityReceived)).toBe(40);
    expect(item.quantityRemaining).toBe(0);
  });

  // ── multi product ────────────────────────────────────────────────────────

  it("B1–B5: multi-product PO status is derived from ALL items", async () => {
    // B1: none received.
    const b1 = await createPo(supplierA, [
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
    ]);
    expect((await getPo(b1.id)).status).toBe("AWAITING_DELIVERY");

    // B2: one item fully received, others untouched -> still partial.
    const b2 = await createPo(supplierA, [
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
    ]);
    await receive(b2.id, [{ itemId: itemOf(b2, pA).id, qty: 40 }]);
    expect((await getPo(b2.id)).status).toBe("PARTIALLY_RECEIVED");

    // B3: one item partially received.
    const b3 = await createPo(supplierA, [
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
    ]);
    await receive(b3.id, [{ itemId: itemOf(b3, pA).id, qty: 20 }]);
    expect((await getPo(b3.id)).status).toBe("PARTIALLY_RECEIVED");

    // B4: mixed full + partial.
    const b4 = await createPo(supplierA, [
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
    ]);
    await receive(b4.id, [
      { itemId: itemOf(b4, pA).id, qty: 40 },
      { itemId: itemOf(b4, pB).id, qty: 20 },
    ]);
    expect((await getPo(b4.id)).status).toBe("PARTIALLY_RECEIVED");

    // B5: everything complete -> RECEIVED.
    const b5 = await createPo(supplierA, [
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
    ]);
    await receive(b5.id, [
      { itemId: itemOf(b5, pA).id, qty: 40 },
      { itemId: itemOf(b5, pB).id, qty: 50 },
      { itemId: itemOf(b5, pC).id, qty: 20 },
    ]);
    const detail = await getPo(b5.id);
    expect(detail.status).toBe("RECEIVED");
    expect(detail.receivingSummary).toMatchObject({
      orderedQuantity: 110,
      receivedQuantity: 110,
      remainingQuantity: 0,
    });
  });

  // ── repeated deliveries ──────────────────────────────────────────────────

  it("repeated deliveries accumulate and keep every receipt in history", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 100 }]);
    const itemId = itemOf(po, pA).id;

    await receive(po.id, [{ itemId, qty: 30 }]);
    expect((await getPo(po.id)).status).toBe("PARTIALLY_RECEIVED");
    await receive(po.id, [{ itemId, qty: 20 }]);
    let detail = await getPo(po.id);
    expect(Number(itemOf(detail, pA).quantityReceived)).toBe(50);
    expect(itemOf(detail, pA).quantityRemaining).toBe(50);

    await receive(po.id, [{ itemId, qty: 50 }]);
    detail = await getPo(po.id);
    expect(detail.status).toBe("RECEIVED");
    expect(Number(itemOf(detail, pA).quantityReceived)).toBe(100);
    expect(itemOf(detail, pA).quantityRemaining).toBe(0);

    const receipts = await request(app)
      .get(`${BASE}/goods-receipts?purchaseOrderId=${po.id}&limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    expect(receipts.body.data).toHaveLength(3);
  });

  // ── selective receiving ──────────────────────────────────────────────────

  it("receiving a subset never treats the unselected item as a shortage", async () => {
    const po = await createPo(supplierA, [
      { productId: pA, qty: 100 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
    ]);

    // Only A and part of C arrive today; B is simply not delivered.
    await receive(po.id, [
      { itemId: itemOf(po, pA).id, qty: 100 },
      { itemId: itemOf(po, pC).id, qty: 10 },
    ]);

    let detail = await getPo(po.id);
    expect(detail.status).toBe("PARTIALLY_RECEIVED");
    const b = itemOf(detail, pB);
    expect(Number(b.quantityReceived)).toBe(0);
    expect(Number(b.quantityShort)).toBe(0);
    expect(b.quantityRemaining).toBe(50);

    // B and the rest of C can still be delivered later.
    await receive(po.id, [
      { itemId: itemOf(detail, pB).id, qty: 50 },
      { itemId: itemOf(detail, pC).id, qty: 10 },
    ]);
    detail = await getPo(po.id);
    expect(detail.status).toBe("RECEIVED");
    expect(itemOf(detail, pB).quantityRemaining).toBe(0);
    expect(itemOf(detail, pC).quantityRemaining).toBe(0);
  });

  // ── supplier -> receivable PO selection ──────────────────────────────────

  it("supplier selection lists AWAITING_DELIVERY + PARTIALLY_RECEIVED with item detail", async () => {
    const po1 = await createPo(supplierSel, [{ productId: pB, qty: 40 }]);
    const po2 = await createPo(supplierSel, [{ productId: pB, qty: 40 }]);
    const po3 = await createPo(supplierSel, [{ productId: pB, qty: 20 }]);

    await receive(po2.id, [{ itemId: itemOf(po2, pB).id, qty: 10 }]);
    await receive(po3.id, [{ itemId: itemOf(po3, pB).id, qty: 20 }]);

    expect((await getPo(po2.id)).status).toBe("PARTIALLY_RECEIVED");
    expect((await getPo(po3.id)).status).toBe("RECEIVED");

    const res = await request(app)
      .get(`${BASE}/purchase-orders?supplierId=${supplierSel}&receivable=true&limit=100`)
      .set("Cookie", cookie)
      .expect(200);

    const ids = (res.body.data as ApiPo[]).map((p) => p.id);
    expect(ids).toContain(po1.id);
    expect(ids).toContain(po2.id);
    expect(ids).not.toContain(po3.id);

    const row = (res.body.data as ApiPo[]).find((p) => p.id === po2.id)!;
    expect(row.items).toHaveLength(1);
    const item = row.items[0]!;
    expect(item.product).toMatchObject({ id: pB });
    expect(typeof item.product!.name).toBe("string");
    expect(typeof item.product!.sku).toBe("string");
    expect(Number(item.quantityOrdered)).toBe(40);
    expect(Number(item.quantityReceived)).toBe(10);
    expect(item.quantityRemaining).toBe(30);
  });

  // ── receiving-item filtering ─────────────────────────────────────────────

  it("receivableItems=true returns only items that still have quantity to receive", async () => {
    const po = await createPo(supplierA, [
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 20 },
      { productId: pD, qty: 10 },
    ]);

    await receive(po.id, [
      { itemId: itemOf(po, pA).id, qty: 40 }, // complete
      { itemId: itemOf(po, pB).id, qty: 20 }, // partial
      { itemId: itemOf(po, pD).id, qty: 10 }, // complete
    ]);

    const receiving = await getPo(po.id, "?receivableItems=true");
    const ids = receiving.items.map((i) => i.productId).sort();
    expect(ids).toEqual([pB, pC].sort());

    const remainingByProduct = new Map(
      receiving.items.map((i) => [i.productId, i.quantityRemaining]),
    );
    expect(remainingByProduct.get(pB)).toBe(30);
    expect(remainingByProduct.get(pC)).toBe(20);
  });

  // ── validation ───────────────────────────────────────────────────────────

  it("rejects over-receiving beyond the remaining quantity", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 100 }]);
    const itemId = itemOf(po, pA).id;
    await receive(po.id, [{ itemId, qty: 70 }]);

    const res = await createReceipt(po.id, [{ itemId, qty: 31 }]).expect(422);
    expect(res.body.error.code).toBe("GR_ITEM_QUANTITY_MISMATCH");
    expect(res.body.error.details).toMatchObject({
      remainingQuantity: 30,
      requestedQuantity: 31,
    });

    // The exact remaining quantity is still accepted and completes the order.
    await receive(po.id, [{ itemId, qty: 30 }]);
    expect((await getPo(po.id)).status).toBe("RECEIVED");
  });

  it("rejects receiving a PO item that is already fully received", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 40 }]);
    const itemId = itemOf(po, pA).id;
    await receive(po.id, [{ itemId, qty: 40 }]);

    const res = await createReceipt(po.id, [{ itemId, qty: 1 }]).expect(422);
    expect(res.body.error.code).toBe("GR_ITEM_QUANTITY_MISMATCH");
  });

  it("rejects an empty goods receipt", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 40 }]);
    const res = await request(app)
      .post(`${BASE}/purchase-orders/${po.id}/goods-receipts`)
      .set("Cookie", cookie)
      .send({ items: [] })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires authentication for the receiving endpoints", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 10 }]);
    await request(app).get(`${BASE}/purchase-orders/${po.id}`).expect(401);
    await request(app)
      .post(`${BASE}/purchase-orders/${po.id}/goods-receipts`)
      .send({ items: [] })
      .expect(401);
  });

  // ── multi-batch ──────────────────────────────────────────────────────────

  it("supports multiple batches for one PO item and sums to the received quantity", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 100 }]);
    const itemId = itemOf(po, pA).id;

    await receive(po.id, [
      { itemId, qty: 60, batch: `MBA-${uniqueSuffix()}` },
      { itemId, qty: 30, batch: `MBB-${uniqueSuffix()}` },
    ]);

    let detail = await getPo(po.id);
    expect(Number(itemOf(detail, pA).quantityReceived)).toBe(90);
    expect(itemOf(detail, pA).quantityRemaining).toBe(10);
    expect(detail.status).toBe("PARTIALLY_RECEIVED");

    // Another batch exceeding the remaining 10 is rejected.
    await createReceipt(po.id, [{ itemId, qty: 11 }]).expect(422);

    await receive(po.id, [{ itemId, qty: 10 }]);
    detail = await getPo(po.id);
    expect(detail.status).toBe("RECEIVED");
    expect(Number(itemOf(detail, pA).quantityReceived)).toBe(100);
  });

  it("rejects batch totals that together exceed the remaining quantity", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 100 }]);
    const itemId = itemOf(po, pA).id;

    const res = await createReceipt(po.id, [
      { itemId, qty: 60, batch: `MBC-${uniqueSuffix()}` },
      { itemId, qty: 60, batch: `MBD-${uniqueSuffix()}` },
    ]).expect(422);
    expect(res.body.error.code).toBe("GR_ITEM_QUANTITY_MISMATCH");
  });

  // ── shortage ─────────────────────────────────────────────────────────────

  it("accepted shortage resolves the remainder without inflating received quantity", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 100 }]);
    const itemId = itemOf(po, pA).id;

    await receive(po.id, [{ itemId, qty: 70 }]);
    let detail = await getPo(po.id);
    const partial = itemOf(detail, pA);
    expect(Number(partial.quantityShort)).toBe(0);
    expect(partial.quantityRemaining).toBe(30);
    expect(detail.status).toBe("PARTIALLY_RECEIVED");

    // Shortage may not exceed the unresolved remaining quantity.
    await request(app)
      .post(`${BASE}/purchase-orders/items/${itemId}/accept-shortage`)
      .set("Cookie", cookie)
      .send({ quantityShort: 31 })
      .expect(422);

    await request(app)
      .post(`${BASE}/purchase-orders/items/${itemId}/accept-shortage`)
      .set("Cookie", cookie)
      .send({ quantityShort: 30, shortReason: "Supplier discontinued the remainder" })
      .expect(201);

    detail = await getPo(po.id);
    expect(detail.status).toBe("RECEIVED");
    const resolved = itemOf(detail, pA);
    // Physical receipt stays accurate: 70, never faked to 100.
    expect(Number(resolved.quantityReceived)).toBe(70);
    expect(Number(resolved.quantityShort)).toBe(30);
    expect(resolved.quantityRemaining).toBe(0);
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  it("concurrent receipts can never over-receive a PO item", async () => {
    const po = await createPo(supplierA, [{ productId: pA, qty: 30 }]);
    const itemId = itemOf(po, pA).id;

    // Both receipts validate at creation time against the same remaining 30.
    const first = await createReceipt(po.id, [{ itemId, qty: 20 }]).expect(201);
    const second = await createReceipt(po.id, [{ itemId, qty: 20 }]).expect(201);

    // Partial quantities make each draft a discrepancy; resolve both so they are
    // confirmable, then race the two confirmations.
    await resolveReceipt(first.body.data.id).expect(200);
    await resolveReceipt(second.body.data.id).expect(200);

    const [a, b] = await Promise.all([
      confirmReceipt(first.body.data.id),
      confirmReceipt(second.body.data.id),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one confirmation wins; the other is rejected because only 10 remain.
    expect(statuses).toEqual([200, 422]);

    const detail = await getPo(po.id);
    const received = Number(itemOf(detail, pA).quantityReceived);
    expect(received).toBeLessThanOrEqual(30);
    expect(received).toBe(20);
  });
});
