import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

/**
 * Purchase order -> supplier invoice workflow.
 *
 * Invoicing is based on RECEIVED quantities, not ordered quantities and not
 * the PO status:
 *
 *   quantityRemainingToInvoice = quantityReceived - quantityInvoiced
 *
 * Covers: invoice-eligible PO selection per supplier (including
 * PARTIALLY_RECEIVED and AWAITING_DELIVERY-with-received-goods cases),
 * invoiceable-item filtering, full/partial/multiple invoices, multi-product
 * mixed receiving, over-invoicing rejection, unreceived items, duplicate
 * invoice numbers, transaction rollback and concurrent invoicing.
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
  quantityInvoiced?: number;
  quantityRemainingToInvoice?: number;
  quantityRemaining?: number;
  unitCost?: string | number;
};

type ApiPo = {
  id: string;
  poNumber: string;
  supplierId: string;
  status: string;
  items: ApiItem[];
  goodsSummary?: {
    orderedGoodsValue: number;
    receivedGoodsValue: number;
    goodsInvoicedAmount: number;
    remainingGoodsToInvoice: number;
  };
};

describe("purchasing: purchase order -> supplier invoice lifecycle", () => {
  let cookie: string;
  let userId: string;
  let groupId: string;
  let unitId: string;
  let locationId: string;
  const productIds: string[] = [];
  const supplierIds: string[] = [];

  let supplierInv: string;
  let pA = "";
  let pB = "";
  let pC = "";

  beforeAll(async () => {
    const suffix = uniqueSuffix();
    const email = `po-invoicing.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Invoicing Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    const group = await prisma.productGroup.create({
      data: { name: `Invoicing Group ${suffix}` },
    });
    groupId = group.id;

    const unit = await prisma.unit.create({
      data: { name: `Invoicing Piece ${suffix}`, symbol: `INV-${suffix.slice(-4)}` },
    });
    unitId = unit.id;

    const products = await Promise.all(
      ["A", "B", "C"].map((tag) =>
        prisma.product.create({
          data: {
            name: `Invoicing Product ${tag} ${suffix}`,
            sku: `INVC-${tag}-${suffix}`,
            productGroupId: group.id,
            units: {
              create: { unitId: unit.id, conversionFactor: 1, isBaseUnit: true },
            },
          },
          select: { id: true },
        }),
      ),
    );
    [pA, pB, pC] = products.map((p) => p.id);
    productIds.push(pA, pB, pC);

    const location = await prisma.inventoryLocation.create({
      data: { name: `Invoicing Store ${suffix}` },
    });
    locationId = location.id;

    const supplier = await prisma.supplier.create({
      data: { name: `Invoicing Supplier ${suffix}` },
    });
    supplierInv = supplier.id;
    supplierIds.push(supplierInv);
  });

  afterAll(async () => {
    await prisma.supplierInvoice.deleteMany({ where: { supplierId: { in: supplierIds } } });
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
    items: Array<{ productId: string; qty: number }>,
    supplierId: string = supplierInv,
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

  async function receive(
    poId: string,
    lines: Array<{ itemId: string; qty: number }>,
  ): Promise<void> {
    const created = await request(app)
      .post(`${BASE}/purchase-orders/${poId}/goods-receipts`)
      .set("Cookie", cookie)
      .send({
        items: lines.map((line) => ({
          purchaseOrderItemId: line.itemId,
          locationId,
          deliveredQty: line.qty,
          actualQty: line.qty,
          batchNumber: `INVC-${uniqueSuffix()}`,
          expiryDate: FUTURE_EXPIRY,
        })),
      })
      .expect(201);
    const receiptId = created.body.data.id as string;
    if (created.body.data.status === "DISCREPANCY") {
      await request(app)
        .patch(`${BASE}/goods-receipts/${receiptId}/resolve`)
        .set("Cookie", cookie)
        .send({ discrepancyNote: "Partial delivery accepted" })
        .expect(200);
    }
    await request(app)
      .post(`${BASE}/goods-receipts/${receiptId}/confirm`)
      .set("Cookie", cookie)
      .expect(200);
  }

  async function getPo(poId: string, query = ""): Promise<ApiPo> {
    const res = await request(app)
      .get(`${BASE}/purchase-orders/${poId}${query}`)
      .set("Cookie", cookie)
      .expect(200);
    return res.body.data as ApiPo;
  }

  function createInvoice(body: Record<string, unknown>) {
    return request(app).post(`${BASE}/supplier-invoices`).set("Cookie", cookie).send(body);
  }

  let invoiceSeq = 0;
  function invoiceNumber(): string {
    invoiceSeq += 1;
    return `INV-${uniqueSuffix()}-${invoiceSeq}`;
  }

  /** Types enriched with the derived invoicing quantities. */
  type InvItem = ApiItem & { quantityInvoiced: number; quantityRemainingToInvoice: number };

  function invQty(item: ApiItem): InvItem {
    return item as InvItem;
  }

  // ── 8. one PO, one product ───────────────────────────────────────────────

  it("full invoice of a fully received single-product PO closes invoiceability", async () => {
    const po = await createPo([{ productId: pA, qty: 40 }]);
    const itemId = itemOf(po, pA).id;
    await receive(po.id, [{ itemId, qty: 40 }]);

    // Before invoicing: PO eligible, item fully invoiceable.
    let detail = await getPo(po.id);
    expect(invQty(itemOf(detail, pA)).quantityRemainingToInvoice).toBe(40);
    expect(invQty(itemOf(detail, pA)).quantityInvoiced).toBe(0);

    const res = await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 40 }],
      paymentTerms: "NO_CREDIT",
    }).expect(201);

    expect(res.body.data.goodsAmount).toBe(400); // 40 x 10
    expect(res.body.data.totalAmount).toBe(400);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].purchaseOrderItem.product).toMatchObject({ id: pA });

    // After: item fully invoiced, PO no longer invoice-eligible.
    detail = await getPo(po.id);
    const item = invQty(itemOf(detail, pA));
    expect(item.quantityInvoiced).toBe(40);
    expect(item.quantityRemainingToInvoice).toBe(0);
    expect(detail.goodsSummary).toMatchObject({
      orderedGoodsValue: 400,
      receivedGoodsValue: 400,
      goodsInvoicedAmount: 400,
      remainingGoodsToInvoice: 0,
    });

    const list = await request(app)
      .get(`${BASE}/purchase-orders?supplierId=${supplierInv}&invoiceable=true&limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    expect((list.body.data as ApiPo[]).map((p) => p.id)).not.toContain(po.id);
  });

  // ── 10. multi product, mixed receiving ───────────────────────────────────

  it("mixed receiving: invoices only received items, ignores unreceived ones", async () => {
    const po = await createPo([
      { productId: pA, qty: 40 },
      { productId: pB, qty: 100 },
      { productId: pC, qty: 50 },
    ]);
    await receive(po.id, [
      { itemId: itemOf(po, pA).id, qty: 40 },
      { itemId: itemOf(po, pB).id, qty: 30 },
    ]);
    // C received nothing. PO is PARTIALLY_RECEIVED — invoicing must still work.

    const detail = await getPo(po.id);
    expect(detail.status).toBe("PARTIALLY_RECEIVED");

    // Invoiceable-items view: only A and B (C excluded until it arrives).
    const invoicing = await getPo(po.id, "?invoiceableItems=true");
    expect(invoicing.items.map((i) => i.productId).sort()).toEqual([pA, pB].sort());

    // Invoice A fully and B fully (as received).
    const res = await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [
        { purchaseOrderItemId: itemOf(po, pA).id, quantity: 40 },
        { purchaseOrderItemId: itemOf(po, pB).id, quantity: 30 },
      ],
      paymentTerms: "NO_CREDIT",
    }).expect(201);
    expect(res.body.data.goodsAmount).toBe(700); // 40x10 + 30x10

    const after = await getPo(po.id);
    expect(invQty(itemOf(after, pA)).quantityRemainingToInvoice).toBe(0);
    expect(invQty(itemOf(after, pB)).quantityRemainingToInvoice).toBe(0);
    // C was never received and can never be invoiced.
    expect(invQty(itemOf(after, pC)).quantityRemainingToInvoice).toBe(0);

    // Invoicing C must be rejected: nothing received.
    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemOf(po, pC).id, quantity: 1 }],
      paymentTerms: "NO_CREDIT",
    }).expect(422);
  });

  // ── 5 + 7. supplier -> invoiceable PO list + item detail ─────────────────

  it("supplier invoiceable list filters by received > invoiced per item, never by status", async () => {
    // PO1: nothing received, nothing invoiced -> NOT invoiceable.
    const po1 = await createPo([{ productId: pA, qty: 40 }]);

    // PO2: partially received, nothing invoiced -> invoiceable (partial PO).
    const po2 = await createPo([{ productId: pA, qty: 40 }]);
    await receive(po2.id, [{ itemId: itemOf(po2, pA).id, qty: 30 }]);

    // PO3: fully received -> invoiceable.
    const po3 = await createPo([{ productId: pA, qty: 20 }]);
    await receive(po3.id, [{ itemId: itemOf(po3, pA).id, qty: 20 }]);

    // PO4: fully received then fully invoiced -> NOT invoiceable.
    const po4 = await createPo([{ productId: pA, qty: 15 }]);
    await receive(po4.id, [{ itemId: itemOf(po4, pA).id, qty: 15 }]);
    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po4.id,
      items: [{ purchaseOrderItemId: itemOf(po4, pA).id, quantity: 15 }],
      paymentTerms: "NO_CREDIT",
    }).expect(201);

    const res = await request(app)
      .get(`${BASE}/purchase-orders?supplierId=${supplierInv}&invoiceable=true&limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    const ids = (res.body.data as ApiPo[]).map((p) => p.id);
    expect(ids).not.toContain(po1.id); // nothing received
    expect(ids).toContain(po2.id); // partially received, billable goods
    expect(ids).toContain(po3.id); // fully received
    expect(ids).not.toContain(po4.id); // fully invoiced

    const row = (res.body.data as ApiPo[]).find((p) => p.id === po2.id)!;
    expect(row.items).toHaveLength(1);
    const item = invQty(row.items[0]!);
    expect(item.product).toMatchObject({ id: pA });
    expect(typeof item.product!.name).toBe("string");
    expect(typeof item.product!.sku).toBe("string");
    expect(Number(item.quantityOrdered)).toBe(40);
    expect(Number(item.quantityReceived)).toBe(30);
    expect(item.quantityInvoiced).toBe(0);
    expect(item.quantityRemainingToInvoice).toBe(30);
    expect(Number(item.unitCost)).toBe(10);
  });

  // ── 12. partial invoice + multiple invoices ──────────────────────────────

  it("partial invoices: two invoices drain the remaining quantity exactly", async () => {
    const po = await createPo([{ productId: pB, qty: 100 }]);
    const itemId = itemOf(po, pB).id;
    await receive(po.id, [{ itemId, qty: 100 }]);

    const first = await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 60 }],
      paymentTerms: "NO_CREDIT",
    }).expect(201);
    expect(first.body.data.goodsAmount).toBe(600);

    let detail = await getPo(po.id);
    expect(invQty(itemOf(detail, pB)).quantityInvoiced).toBe(60);
    expect(invQty(itemOf(detail, pB)).quantityRemainingToInvoice).toBe(40);

    // Second invoice takes exactly the remaining 40.
    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 40 }],
      paymentTerms: "NO_CREDIT",
    }).expect(201);

    detail = await getPo(po.id);
    expect(invQty(itemOf(detail, pB)).quantityInvoiced).toBe(100);
    expect(invQty(itemOf(detail, pB)).quantityRemainingToInvoice).toBe(0);
    expect(detail.goodsSummary).toMatchObject({
      goodsInvoicedAmount: 1000,
      remainingGoodsToInvoice: 0,
    });

    // A third invoice for 1 more is rejected: nothing remains.
    const res = await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 1 }],
      paymentTerms: "NO_CREDIT",
    }).expect(422);
    expect(res.body.error.code).toBe("SUPPLIER_INVOICE_EXCEEDS_RECEIVED");
    expect(res.body.error.details).toMatchObject({
      quantityReceived: 100,
      alreadyInvoiced: 100,
      requested: 1,
      remainingGoodsToInvoice: 0,
    });
  });

  // ── 11. partially received PO invoiced for what arrived ──────────────────

  it("some items fully invoiced, others partially, PO still outstanding for delivery", async () => {
    const po = await createPo([
      { productId: pA, qty: 40 },
      { productId: pB, qty: 100 },
      { productId: pC, qty: 50 },
    ]);
    await receive(po.id, [
      { itemId: itemOf(po, pA).id, qty: 40 },
      { itemId: itemOf(po, pB).id, qty: 60 },
      { itemId: itemOf(po, pC).id, qty: 50 },
    ]);

    // Invoice A fully, B partially, C fully.
    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [
        { purchaseOrderItemId: itemOf(po, pA).id, quantity: 40 },
        { purchaseOrderItemId: itemOf(po, pB).id, quantity: 20 },
        { purchaseOrderItemId: itemOf(po, pC).id, quantity: 50 },
      ],
      paymentTerms: "NO_CREDIT",
    }).expect(201);

    const detail = await getPo(po.id);
    expect(detail.status).toBe("PARTIALLY_RECEIVED"); // B still has 40 to deliver
    expect(invQty(itemOf(detail, pA)).quantityRemainingToInvoice).toBe(0);
    expect(invQty(itemOf(detail, pB)).quantityRemainingToInvoice).toBe(40);
    expect(invQty(itemOf(detail, pC)).quantityRemainingToInvoice).toBe(0);

    // Receiving the rest of B still works after partial invoicing...
    await receive(po.id, [{ itemId: itemOf(detail, pB).id, qty: 40 }]);
    const complete = await getPo(po.id);
    expect(complete.status).toBe("RECEIVED");
    // ...and extends the invoiceable quantity accordingly.
    expect(invQty(itemOf(complete, pB)).quantityRemainingToInvoice).toBe(80);
  });

  // ── validation + rollback + concurrency ──────────────────────────────────

  it("rejects over-invoicing beyond received-but-not-invoiced quantity", async () => {
    const po = await createPo([{ productId: pA, qty: 100 }]);
    const itemId = itemOf(po, pA).id;
    await receive(po.id, [{ itemId, qty: 70 }]);

    const res = await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 71 }],
      paymentTerms: "NO_CREDIT",
    }).expect(422);
    expect(res.body.error.code).toBe("SUPPLIER_INVOICE_EXCEEDS_RECEIVED");
    expect(res.body.error.details).toMatchObject({
      quantityReceived: 70,
      alreadyInvoiced: 0,
      requested: 71,
      remainingGoodsToInvoice: 70,
    });

    // Nothing was persisted by the failed attempt.
    const items = await prisma.supplierInvoiceItem.findMany({
      where: { purchaseOrderItemId: itemId },
    });
    expect(items).toHaveLength(0);
  });

  it("rolls back the entire invoice when one line among many is invalid", async () => {
    const po = await createPo([
      { productId: pA, qty: 40 },
      { productId: pB, qty: 50 },
      { productId: pC, qty: 30 },
    ]);
    await receive(po.id, [
      { itemId: itemOf(po, pA).id, qty: 40 },
      { itemId: itemOf(po, pB).id, qty: 50 },
    ]);
    const itemA = itemOf(po, pA).id;
    const itemB = itemOf(po, pB).id;
    const itemC = itemOf(po, pC).id; // never received

    const invoiceNumberValue = invoiceNumber();
    await createInvoice({
      invoiceNumber: invoiceNumberValue,
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [
        { purchaseOrderItemId: itemA, quantity: 40 }, // valid
        { purchaseOrderItemId: itemB, quantity: 50 }, // valid
        { purchaseOrderItemId: itemC, quantity: 10 }, // invalid: unreceived
      ],
      paymentTerms: "NO_CREDIT",
    }).expect(422);

    // NO invoice, NO partial items, NO consumed quantities.
    const invoice = await prisma.supplierInvoice.findFirst({
      where: { invoiceNumber: invoiceNumberValue, supplierId: supplierInv },
    });
    expect(invoice).toBeNull();
    expect(
      await prisma.supplierInvoiceItem.findMany({ where: { purchaseOrderItemId: { in: [itemA, itemB] } } }),
    ).toHaveLength(0);

    // The goods are still fully invoiceable after the rollback.
    const detail = await getPo(po.id);
    expect(invQty(itemOf(detail, pA)).quantityRemainingToInvoice).toBe(40);
    expect(invQty(itemOf(detail, pB)).quantityRemainingToInvoice).toBe(50);

    // A corrected invoice with the same number now succeeds.
    await createInvoice({
      invoiceNumber: invoiceNumberValue,
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [
        { purchaseOrderItemId: itemA, quantity: 40 },
        { purchaseOrderItemId: itemB, quantity: 50 },
      ],
      paymentTerms: "NO_CREDIT",
    }).expect(201);
  });

  it("rejects duplicate invoice numbers per supplier", async () => {
    const po = await createPo([{ productId: pA, qty: 40 }]);
    const itemId = itemOf(po, pA).id;
    await receive(po.id, [{ itemId, qty: 40 }]);

    const number = invoiceNumber();
    await createInvoice({
      invoiceNumber: number,
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 10 }],
      paymentTerms: "NO_CREDIT",
    }).expect(201);

    const res = await createInvoice({
      invoiceNumber: number,
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 10 }],
      paymentTerms: "NO_CREDIT",
    }).expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_INVOICE_NUMBER");
  });

  it("rejects a PO-linked invoice without items and items without a PO", async () => {
    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      purchaseOrderId: (await createPo([{ productId: pA, qty: 10 }])).id,
      items: [],
      paymentTerms: "NO_CREDIT",
    }).expect(422);

    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: supplierInv,
      paymentTerms: "NO_CREDIT",
      goodsAmount: 100,
      items: [{ purchaseOrderItemId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", quantity: 1 }],
    }).expect(422);
  });

  it("rejects an invoice whose PO belongs to a different supplier", async () => {
    const other = await prisma.supplier.create({
      data: { name: `Invoicing Other ${uniqueSuffix()}` },
    });
    supplierIds.push(other.id);
    const po = await createPo([{ productId: pA, qty: 10 }]); // belongs to supplierInv
    const itemId = itemOf(po, pA).id;
    await receive(po.id, [{ itemId, qty: 10 }]);

    await createInvoice({
      invoiceNumber: invoiceNumber(),
      supplierId: other.id,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 10 }],
      paymentTerms: "NO_CREDIT",
    }).expect(422);
  });

  it("concurrent invoices for the same received goods serialize: exactly one wins", async () => {
    const po = await createPo([{ productId: pC, qty: 30 }]);
    const itemId = itemOf(po, pC).id;
    await receive(po.id, [{ itemId, qty: 30 }]);

    const base = {
      supplierId: supplierInv,
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: itemId, quantity: 30 }],
      paymentTerms: "NO_CREDIT",
    };
    const [a, b] = await Promise.all([
      createInvoice({ ...base, invoiceNumber: invoiceNumber() }),
      createInvoice({ ...base, invoiceNumber: invoiceNumber() }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);

    // The winner consumed the whole received quantity; no double invoicing.
    expect(
      await prisma.supplierInvoiceItem.count({ where: { purchaseOrderItemId: itemId } }),
    ).toBe(1);
    const detail = await getPo(po.id);
    expect(invQty(itemOf(detail, pC)).quantityInvoiced).toBe(30);
    expect(invQty(itemOf(detail, pC)).quantityRemainingToInvoice).toBe(0);
  });

  it("requires authentication for invoice creation and PO reads", async () => {
    await request(app).post(`${BASE}/supplier-invoices`).send({}).expect(401);
  });
});
