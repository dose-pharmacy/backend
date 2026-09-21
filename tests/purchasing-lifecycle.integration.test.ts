import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

/**
 * Purchasing lifecycle tests: partial deliveries, multiple deliveries,
 * accepted shortages, multiple POs per requirement, multiple invoices per PO,
 * multiple payments per invoice, PO payment status, and concurrency safety.
 *
 * Mirrors the setup style of purchasing.integration.test.ts.
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

describe("purchasing: deliveries, shortages, invoices and payments", () => {
  let cookie: string;
  let userId: string;
  let groupId: string;
  let productId: string;
  let locationId: string;
  let testUnitId: string;
  let supplierA: string;
  let supplierB: string;
  const requirementIds: string[] = [];
  const poIds: string[] = [];

  beforeAll(async () => {
    const suffix = uniqueSuffix();
    const email = `purchasing-lifecycle.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Lifecycle Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    const group = await prisma.productGroup.create({
      data: { name: `Lifecycle Group ${suffix}` },
    });
    groupId = group.id;

    const product = await prisma.product.create({
      data: {
        name: `Ibuprofen 400mg ${suffix}`,
        sku: `IBU-${suffix}`,
        productGroupId: group.id,
      },
    });
    productId = product.id;

    const location = await prisma.inventoryLocation.create({
      data: { name: `Lifecycle Store ${suffix}` },
    });
    locationId = location.id;

    // Base unit for the product (Unit + ProductUnit, conversion 1).
    const unit = await prisma.unit.create({
      data: { name: `Piece ${suffix}`, symbol: `pc-${suffix}` },
    });
    await prisma.productUnit.create({
      data: {
        productId: product.id,
        unitId: unit.id,
        conversionFactor: 1,
        isBaseUnit: true,
      },
    });
    testUnitId = unit.id;

    const [a, b] = await Promise.all([
      prisma.supplier.create({ data: { name: `Lifecycle Supplier A ${suffix}` } }),
      prisma.supplier.create({ data: { name: `Lifecycle Supplier B ${suffix}` } }),
    ]);
    supplierA = a.id;
    supplierB = b.id;
  });

  afterAll(async () => {
    // Clean up in order of FK dependencies: allocations and receipts first,
    // then POs, then requirements, then products, then the rest.
    await prisma.purchaseRequirementAllocation.deleteMany({
      where: { requirementLine: { requirementId: { in: requirementIds } } },
    });
    await prisma.goodsReceiptItem.deleteMany({
      where: { purchaseOrderItem: { purchaseOrderId: { in: poIds } } },
    });
    await prisma.goodsReceipt.deleteMany({
      where: { purchaseOrderId: { in: poIds } },
    });
    await prisma.supplierPayment.deleteMany({
      where: { supplierInvoice: { purchaseOrderId: { in: poIds } } },
    });
    await prisma.supplierInvoice.deleteMany({
      where: { purchaseOrderId: { in: poIds } },
    });
    await prisma.stockTransaction.deleteMany({ where: { productId } });
    await prisma.inventoryStock.deleteMany({ where: { productId } });
    await prisma.batch.deleteMany({ where: { productId } });
    await prisma.goodsReceiptItem.deleteMany({
      where: { goodsReceipt: { purchaseOrderId: { in: poIds } } },
    });
    await prisma.goodsReceipt.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.purchaseRequirementLine.deleteMany({ where: { requirementId: { in: requirementIds } } });
    await prisma.purchaseRequirement.deleteMany({ where: { id: { in: requirementIds } } });
    await prisma.productUnit.deleteMany({ where: { productId } });
    await prisma.unit.deleteMany({ where: { id: testUnitId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.productGroup.deleteMany({ where: { id: groupId } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierA, supplierB] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function createRequirement(quantityNeeded: number): Promise<string> {
    const res = await request(app)
      .post(`${BASE}/requirements`)
      .set("Cookie", cookie)
      .send({ lines: [{ productId, quantityNeeded }] })
      .expect(201);
    const id = res.body.data.id as string;
    requirementIds.push(id);
    return id;
  }

  async function createPo(
    supplierId: string,
    quantityOrdered: number,
    requirementLineId?: string,
  ): Promise<{ poId: string; itemId: string }> {
    const body: Record<string, unknown> = {
      supplierId,
      items: [
        {
          productId,
          quantityOrdered,
          unitCost: 10,
          ...(requirementLineId ? { requirementLineId } : {}),
        },
      ],
    };
    const res = await request(app)
      .post(`${BASE}/purchase-orders`)
      .set("Cookie", cookie)
      .send(body)
      .expect(201);
    const poId = res.body.data.id as string;
    poIds.push(poId);
    return { poId, itemId: res.body.data.items[0].id as string };
  }

  function createReceipt(poId: string, itemId: string, qty: number, batchNumber?: string) {
    return request(app)
      .post(`${BASE}/purchase-orders/${poId}/goods-receipts`)
      .set("Cookie", cookie)
      .send({
        items: [
          {
            purchaseOrderItemId: itemId,
            locationId,
            deliveredQty: qty,
            actualQty: qty,
            batchNumber: batchNumber ?? `LB-${uniqueSuffix()}`,
            expiryDate: FUTURE_EXPIRY,
          },
        ],
      });
  }

  async function resolveReceipt(receiptId: string) {
    return request(app)
      .patch(`${BASE}/goods-receipts/${receiptId}/resolve`)
      .set("Cookie", cookie)
      .send({ discrepancyNote: "Partial delivery accepted" })
      .expect(200);
  }

  function confirmReceipt(receiptId: string) {
    return request(app)
      .post(`${BASE}/goods-receipts/${receiptId}/confirm`)
      .set("Cookie", cookie);
  }

  async function getPo(poId: string) {
    const res = await request(app)
      .get(`${BASE}/purchase-orders/${poId}`)
      .set("Cookie", cookie)
      .expect(200);
    return res.body.data;
  }

  async function stockForProduct(): Promise<number> {
    const agg = await prisma.inventoryStock.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    return agg._sum.quantity?.toNumber() ?? 0;
  }

  /** Receive all ordered units of a PO's item so goods can be invoiced. */
  async function receiveAll(poId: string, itemId: string, orderedQty: number) {
    const created = await createReceipt(poId, itemId, orderedQty).expect(201);
    if (created.body.data.status === "DISCREPANCY") {
      await resolveReceipt(created.body.data.id);
    }
    await confirmReceipt(created.body.data.id).expect(200);
  }

  /** Legacy-style invoice (whole PO invoiced at unitCost 10). */
  async function createInvoice(poId: string, supplierId: string, amount: number) {
    // Allocate goods to PO items proportionally to the PO's received quantities.
    const poRes = await request(app)
      .get(`${BASE}/purchase-orders/${poId}`)
      .set("Cookie", cookie)
      .expect(200);
    const items = (poRes.body.data.items as Array<{
      id: string;
      quantityReceived: number;
      quantityOrdered: number;
      unitCost: number;
    }>).map((it) => ({
      purchaseOrderItemId: it.id,
      quantity: Math.min(it.quantityReceived, amount / it.unitCost),
    }));
    const res = await request(app)
      .post(`${BASE}/supplier-invoices`)
      .set("Cookie", cookie)
      .send({
        invoiceNumber: `INV-${uniqueSuffix()}`,
        supplierId,
        purchaseOrderId: poId,
        goodsAmount: amount,
        items,
      })
      .expect(201);
    return res.body.data.id as string;
  }

  function payInvoice(invoiceId: string, amount: number) {
    return request(app)
      .post(`${BASE}/supplier-invoices/${invoiceId}/payments`)
      .set("Cookie", cookie)
      .send({ amount });
  }

  // ── receiving scenarios (tests 1–5) ─────────────────────────────────────

  it("Test 1: full delivery -> PO RECEIVED", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    const receipt = await createReceipt(poId, itemId, 50).expect(201);

    await confirmReceipt(receipt.body.data.id).expect(200);

    const po = await getPo(poId);
    expect(po.status).toBe("RECEIVED");
    expect(po.receivingSummary).toMatchObject({
      orderedQuantity: 50,
      receivedQuantity: 50,
      shortQuantity: 0,
      remainingQuantity: 0,
    });
  });

  it("Test 2: partial delivery -> AWAITING_DELIVERY with remaining", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    const receipt = await createReceipt(poId, itemId, 30).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);

    const po = await getPo(poId);
    expect(po.status).toBe("AWAITING_DELIVERY");
    expect(po.receivingSummary).toMatchObject({
      orderedQuantity: 50,
      receivedQuantity: 30,
      shortQuantity: 0,
      remainingQuantity: 20,
    });
  });

  it("Test 3: partial then remaining delivery -> RECEIVED", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);

    const r1 = await createReceipt(poId, itemId, 30).expect(201);
    await resolveReceipt(r1.body.data.id);
    await confirmReceipt(r1.body.data.id).expect(200);

    const r2 = await createReceipt(poId, itemId, 20).expect(201);
    await confirmReceipt(r2.body.data.id).expect(200);

    const po = await getPo(poId);
    expect(po.status).toBe("RECEIVED");
    expect(po.receivingSummary.receivedQuantity).toBe(50);
    expect(po.receivingSummary.remainingQuantity).toBe(0);
  });

  it("Test 4: multiple partial deliveries accumulate", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    for (const qty of [10, 10, 10]) {
      const r = await createReceipt(poId, itemId, qty).expect(201);
      await resolveReceipt(r.body.data.id);
      await confirmReceipt(r.body.data.id).expect(200);
    }
    const r4 = await createReceipt(poId, itemId, 20).expect(201);
    await confirmReceipt(r4.body.data.id).expect(200);

    const po = await getPo(poId);
    expect(po.status).toBe("RECEIVED");
    expect(po.receivingSummary.receivedQuantity).toBe(50);
  });

  it("Test 5: accepted shortage -> RECEIVED, stock increases by received only", async () => {
    const before = await stockForProduct();
    const { poId, itemId } = await createPo(supplierA, 50);

    const receipt = await createReceipt(poId, itemId, 30).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);

    await request(app)
      .post(`${BASE}/purchase-orders/items/${itemId}/accept-shortage`)
      .set("Cookie", cookie)
      .send({ quantityShort: 20, shortReason: "Supplier cannot fulfill remainder" })
      .expect(201);

    const po = await getPo(poId);
    expect(po.status).toBe("RECEIVED");
    expect(po.receivingSummary).toMatchObject({
      orderedQuantity: 50,
      receivedQuantity: 30,
      shortQuantity: 20,
      remainingQuantity: 0,
    });
    expect(po.items[0].shortReason).toBe("Supplier cannot fulfill remainder");

    // Stock must reflect 30 received, NOT 50.
    expect((await stockForProduct()) - before).toBe(30);
  });

  it("rejects shortage that would exceed the ordered quantity", async () => {
    const { poId, itemId } = await createPo(supplierA, 10);
    const res = await request(app)
      .post(`${BASE}/purchase-orders/items/${itemId}/accept-shortage`)
      .set("Cookie", cookie)
      .send({ quantityShort: 11 })
      .expect(422);
    expect(res.body.error.code).toBe("BAD_REQUEST");

    await request(app)
      .post(`${BASE}/purchase-orders/${poId}/cancel`)
      .set("Cookie", cookie)
      .expect(200);
  });

  // ── requirement scenarios (tests 6–7) ───────────────────────────────────

  it("Test 6: requirement with shortage keeps remaining = actually received", async () => {
    const requirementId = await createRequirement(100);
    const lineRes = await request(app)
      .get(`${BASE}/requirements/${requirementId}`)
      .set("Cookie", cookie)
      .expect(200);
    const lineId = lineRes.body.data.lines[0].id as string;

    const { poId, itemId } = await createPo(supplierA, 70, lineId);
    const receipt = await createReceipt(poId, itemId, 50).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);
    await request(app)
      .post(`${BASE}/purchase-orders/items/${itemId}/accept-shortage`)
      .set("Cookie", cookie)
      .send({ quantityShort: 20 })
      .expect(201);

    const line = (await getPoLine(requirementId, lineId)) as Record<string, unknown>;
    // Only actually-received units count as delivered; shortage must NOT count.
    expect(line.quantityDelivered).toBe(50);
    // The remaining 50 can still be ordered from another supplier.
    const res = await request(app)
      .post(`${BASE}/purchase-orders/from-requirement`)
      .set("Cookie", cookie)
      .send({
        supplierId: supplierB,
        items: [{ requirementLineId: lineId, quantityOrdered: 50, unitCost: 10 }],
      })
      .expect(201);
    poIds.push(res.body.data.id as string);
  });

  it("Test 7: requirement fulfilled across multiple suppliers", async () => {
    const requirementId = await createRequirement(100);
    const lineRes = await request(app)
      .get(`${BASE}/requirements/${requirementId}`)
      .set("Cookie", cookie)
      .expect(200);
    const lineId = lineRes.body.data.lines[0].id as string;

    const poA = await createPo(supplierA, 60, lineId);
    const poB = await createPo(supplierB, 40, lineId);

    const rA = await createReceipt(poA.poId, poA.itemId, 60).expect(201);
    await confirmReceipt(rA.body.data.id).expect(200);
    const rB = await createReceipt(poB.poId, poB.itemId, 40).expect(201);
    await confirmReceipt(rB.body.data.id).expect(200);

    const line = await getPoLine(requirementId, lineId);
    expect(line.quantityDelivered).toBe(100);
  });

  async function getPoLine(requirementId: string, lineId: string) {
    const res = await request(app)
      .get(`${BASE}/requirements/${requirementId}`)
      .set("Cookie", cookie)
      .expect(200);
    return res.body.data.lines.find((l: { id: string }) => l.id === lineId);
  }

  // ── invoice / payment scenarios (tests 8–14) ────────────────────────────

  it("Test 8: multiple invoices on one PO aggregate", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    await receiveAll(poId, itemId, 50);
    await createInvoice(poId, supplierA, 300);
    await createInvoice(poId, supplierA, 200);

    const po = await getPo(poId);
    expect(po.paymentSummary).toMatchObject({
      status: "UNPAID",
      invoiceCount: 2,
      invoicedAmount: 500,
      paidAmount: 0,
      outstandingAmount: 500,
    });
  });

  it("Test 9: multiple payments -> PARTIALLY_PAID", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    await receiveAll(poId, itemId, 50);
    const invoiceId = await createInvoice(poId, supplierA, 500);

    await payInvoice(invoiceId, 200).expect(201);
    await payInvoice(invoiceId, 100).expect(201);

    const invoice = await request(app)
      .get(`${BASE}/supplier-invoices/${invoiceId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(invoice.body.data.status).toBe("PARTIALLY_PAID");
    expect(invoice.body.data.outstandingBalance).toBe(200);

    const po = await getPo(poId);
    expect(po.paymentSummary.status).toBe("PARTIALLY_PAID");
  });

  it("Test 10: multiple invoices + payments -> PO PARTIALLY_PAID", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    await receiveAll(poId, itemId, 50);
    const inv1 = await createInvoice(poId, supplierA, 300);
    const inv2 = await createInvoice(poId, supplierA, 200);

    await payInvoice(inv1, 300).expect(201);
    await payInvoice(inv2, 50).expect(201);

    const po = await getPo(poId);
    expect(po.paymentSummary).toMatchObject({
      status: "PARTIALLY_PAID",
      invoiceCount: 2,
      invoicedAmount: 500,
      paidAmount: 350,
      outstandingAmount: 150,
    });
  });

  it("Test 11: PO without invoices -> NOT_INVOICED via list filter", async () => {
    const { poId } = await createPo(supplierA, 5);

    const res = await request(app)
      .get(`${BASE}/purchase-orders?paymentStatus=NOT_INVOICED&limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(poId);
    expect(
      res.body.data.every(
        (p: { paymentSummary: { status: string } }) =>
          p.paymentSummary.status === "NOT_INVOICED",
      ),
    ).toBe(true);
  });

  it("Test 12: unpaid invoices -> UNPAID via list filter", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    await receiveAll(poId, itemId, 50);
    await createInvoice(poId, supplierA, 500);

    const res = await request(app)
      .get(`${BASE}/purchase-orders?paymentStatus=UNPAID&limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(poId);
  });

  it("Test 13: fully paid invoices -> PAID via list filter", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    await receiveAll(poId, itemId, 50);
    const inv = await createInvoice(poId, supplierA, 500);
    await payInvoice(inv, 500).expect(201);

    const res = await request(app)
      .get(`${BASE}/purchase-orders?paymentStatus=PAID&limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(poId);
  });

  it("Test 14: invoice amount differing from received value is preserved", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);

    // Received value = 30 x 10 = 300.
    const receipt = await createReceipt(poId, itemId, 30).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);

    // Supplier bills 500 — must NOT be adjusted. goodsAmount (300) comes from
    // the allocation; the extra 200 is billed as tax/charges on top.
    const res = await request(app)
      .post(`${BASE}/supplier-invoices`)
      .set("Cookie", cookie)
      .send({
        invoiceNumber: `INV-${uniqueSuffix()}`,
        supplierId: supplierA,
        purchaseOrderId: poId,
        goodsAmount: 300,
        items: [{ purchaseOrderItemId: itemId, quantity: 30 }],
        taxAmount: 200,
      })
      .expect(201);
    const inv = res.body.data.id as string;
    const invoice = await request(app)
      .get(`${BASE}/supplier-invoices/${inv}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(Number(invoice.body.data.goodsAmount)).toBe(300);
    expect(Number(invoice.body.data.totalAmount)).toBe(500);
    expect(invoice.body.data.invoiceAmount).toBe(500);
    expect(invoice.body.data.outstandingBalance).toBe(500);

    const po = await getPo(poId);
    expect(po.paymentSummary.invoicedAmount).toBe(500);
  });

  it("rejects overpayment of an invoice", async () => {
    const { poId, itemId } = await createPo(supplierA, 10);
    await receiveAll(poId, itemId, 10);
    const inv = await createInvoice(poId, supplierA, 100);
    const res = await payInvoice(inv, 150).expect(422);
    expect(res.body.error.code).toBe("SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE");
  });

  // ── concurrency (tests 15–16) ────────────────────────────────────────────

  it("Test 15: concurrent confirmation of the same receipt is idempotent", async () => {
    const before = await stockForProduct();
    const { poId, itemId } = await createPo(supplierA, 100);
    const receipt = await createReceipt(poId, itemId, 40).expect(201);
    const receiptId = receipt.body.data.id as string;
    await resolveReceipt(receiptId);

    const [a, b] = await Promise.all([
      confirmReceipt(receiptId),
      confirmReceipt(receiptId),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one confirm succeeds; the other is rejected as already confirmed.
    expect(statuses).toEqual([200, 409]);

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: itemId } });
    expect(item!.quantityReceived.toNumber()).toBe(40);

    const movements = await prisma.stockTransaction.count({
      where: { referenceType: "GoodsReceipt", referenceId: receiptId },
    });
    expect(movements).toBe(1);
    expect((await stockForProduct()) - before).toBe(40);

    const po = await getPo(poId);
    expect(po.status).toBe("AWAITING_DELIVERY");
  });

  it("Test 16: concurrent payments can never exceed the invoice amount", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    await receiveAll(poId, itemId, 50);
    const inv = await createInvoice(poId, supplierA, 500);

    const [a, b] = await Promise.all([payInvoice(inv, 400), payInvoice(inv, 400)]);
    const statuses = [a.status, b.status].sort();
    // Exactly one payment succeeds; the other exceeds the remaining balance.
    expect(statuses).toEqual([201, 422]);

    const invoice = await request(app)
      .get(`${BASE}/supplier-invoices/${inv}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(invoice.body.data.outstandingBalance).toBe(100);
    expect(invoice.body.data.payments).toHaveLength(1);
  });

  // ── close semantics ─────────────────────────────────────────────────────

  it("a PO completed via shortage can be closed", async () => {
    const { poId, itemId } = await createPo(supplierA, 20);
    const receipt = await createReceipt(poId, itemId, 15).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);
    await request(app)
      .post(`${BASE}/purchase-orders/items/${itemId}/accept-shortage`)
      .set("Cookie", cookie)
      .send({ quantityShort: 5, shortReason: "Discontinued" })
      .expect(201);

    await request(app)
      .post(`${BASE}/purchase-orders/${poId}/close`)
      .set("Cookie", cookie)
      .expect(200);

    const po = await getPo(poId);
    expect(po.status).toBe("CLOSED");
  });

  it("a partially received PO cannot be closed", async () => {
    const { poId, itemId } = await createPo(supplierA, 20);
    const receipt = await createReceipt(poId, itemId, 10).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);

    const res = await request(app)
      .post(`${BASE}/purchase-orders/${poId}/close`)
      .set("Cookie", cookie)
      .expect(409);
    expect(res.body.error.code).toBe("PO_STATUS_TRANSITION_INVALID");
  });

  // ── financial model (spec cases A–E) ─────────────────────────────────────

  it("Case A: goods + tax + charges = total; outstanding from total, not goods", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    const receipt = await createReceipt(poId, itemId, 30).expect(201);
    await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);

    const res = await request(app)
      .post(`${BASE}/supplier-invoices`)
      .set("Cookie", cookie)
      .send({
        invoiceNumber: `INV-${uniqueSuffix()}`,
        supplierId: supplierA,
        purchaseOrderId: poId,
        items: [{ purchaseOrderItemId: itemId, quantity: 30 }],
        taxAmount: 50,
        additionalChargesAmount: 20,
      })
      .expect(201);
    const inv = res.body.data;
    poIds.push(inv.purchaseOrderId);

    // 30 units x 10 = 300 goods; total = 300 + 50 + 20 = 370
    expect(Number(inv.goodsAmount)).toBe(300);
    expect(Number(inv.totalAmount)).toBe(370);
    expect(Number(inv.outstandingBalance)).toBe(370);
    expect(inv.status).toBe("OPEN");

    await payInvoice(inv.id, 200).expect(201);
    const after = await request(app)
      .get(`${BASE}/supplier-invoices/${inv.id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(Number(after.body.data.outstandingBalance)).toBe(170);
    expect(after.body.data.status).toBe("PARTIALLY_PAID");
  });

  it("Case B: multiple invoices aggregate goods invoiced vs invoice totals", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    const r1 = await createReceipt(poId, itemId, 30).expect(201);
    if (r1.body.data.status === "DISCREPANCY") await resolveReceipt(r1.body.data.id);
    await confirmReceipt(r1.body.data.id).expect(200);
    const inv1Id = await createInvoice(poId, supplierA, 300);
    await payInvoice(inv1Id, 300).expect(201);

    const r2 = await createReceipt(poId, itemId, 20).expect(201);
    if (r2.body.data.status === "DISCREPANCY") await resolveReceipt(r2.body.data.id);
    await confirmReceipt(r2.body.data.id).expect(200);
    const inv2Id = await createInvoice(poId, supplierA, 200);
    await payInvoice(inv2Id, 100).expect(201);

    const po = await getPo(poId);
    // Goods concepts vs payment concepts stay distinct.
    expect(Number(po.goodsSummary.orderedGoodsValue)).toBe(500);
    expect(Number(po.goodsSummary.receivedGoodsValue)).toBe(500);
    expect(Number(po.goodsSummary.goodsInvoicedAmount)).toBe(500);
    expect(Number(po.goodsSummary.remainingGoodsToInvoice)).toBe(0);
    expect(Number(po.paymentSummary.invoicedAmount)).toBe(500);
    expect(Number(po.paymentSummary.paidAmount)).toBe(400);
    expect(Number(po.paymentSummary.outstandingAmount)).toBe(100);
    expect(po.paymentSummary.status).toBe("PARTIALLY_PAID");
    expect(po.paymentSummary.invoiceCount).toBe(2);
  });

  it("Case D: rejects invoicing more received goods than remain uninvoiced", async () => {
    const { poId, itemId } = await createPo(supplierA, 30);
    const receipt = await createReceipt(poId, itemId, 30).expect(201);
    if (receipt.body.data.status === "DISCREPANCY") await resolveReceipt(receipt.body.data.id);
    await confirmReceipt(receipt.body.data.id).expect(200);
    await createInvoice(poId, supplierA, 300);

    const res = await request(app)
      .post(`${BASE}/supplier-invoices`)
      .set("Cookie", cookie)
      .send({
        invoiceNumber: `INV-${uniqueSuffix()}`,
        supplierId: supplierA,
        purchaseOrderId: poId,
        items: [{ purchaseOrderItemId: itemId, quantity: 5 }],
      })
      .expect(422);
    expect(res.body.error.code).toBe("SUPPLIER_INVOICE_EXCEEDS_RECEIVED");
  });

  it("Case E: paid invoice but later goods arrive -> PAID with remainingGoodsToInvoice", async () => {
    const { poId, itemId } = await createPo(supplierA, 50);
    const r1 = await createReceipt(poId, itemId, 30).expect(201);
    if (r1.body.data.status === "DISCREPANCY") await resolveReceipt(r1.body.data.id);
    await confirmReceipt(r1.body.data.id).expect(200);
    const invId = await createInvoice(poId, supplierA, 300);
    await payInvoice(invId, 300).expect(201);

    const r2 = await createReceipt(poId, itemId, 20).expect(201);
    if (r2.body.data.status === "DISCREPANCY") await resolveReceipt(r2.body.data.id);
    await confirmReceipt(r2.body.data.id).expect(200);

    const po = await getPo(poId);
    expect(po.paymentSummary.status).toBe("PAID");
    expect(Number(po.paymentSummary.paidAmount)).toBe(300);
    expect(Number(po.goodsSummary.remainingGoodsToInvoice)).toBe(200);
  });

  it("list summaries: purchase-orders include status counts; goods-receipts include matched/discrepancy/resolved", async () => {
    const poRes = await request(app)
      .get(`${BASE}/purchase-orders?page=1&limit=5`)
      .set("Cookie", cookie)
      .expect(200);
    expect(poRes.body.summary).toBeDefined();
    expect(typeof poRes.body.summary.registered).toBe("number");
    expect(typeof poRes.body.summary.closed).toBe("number");

    const grRes = await request(app)
      .get(`${BASE}/goods-receipts?page=1&limit=5`)
      .set("Cookie", cookie)
      .expect(200);
    expect(grRes.body.summary).toBeDefined();
    expect(typeof grRes.body.summary.matched).toBe("number");
  });
});
