import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";
import { purchaseReturnService } from "../src/services/purchasing/purchase-return.service.js";
import { supplierInvoiceService } from "../src/services/purchasing/supplier-invoice.service.js";
import { getReturnableState } from "../src/services/purchasing/purchase-return.service.js";
import { notificationService } from "../src/services/notification/notification.service.js";

/**
 * Purchase return <-> supplier invoice/payment financial linkage.
 *
 * Business rules under test:
 *  - the return VALUE is derived server-side from the PO item's unit cost
 *    (converted to per-base-unit) x returned base quantity; client echoes must
 *    match or the request is rejected;
 *  - returned quantity is capped at quantityReceived MINUS previous returns;
 *  - the return value is applied against the PO's outstanding payables
 *    oldest-first, atomically and never below zero; the unapplied remainder is
 *    the supplier refund/credit effect (appliedToPayable < debitNoteAmount);
 *  - returns recorded BEFORE invoicing surface as a pending credit that
 *    reduces the invoice's opening outstanding balance;
 *  - returns, stock movements, balance decrements and audit events commit in
 *    ONE transaction - a failure rolls everything back;
 *  - retries with the same idempotency key never duplicate anything.
 *
 * These tests hit a remote database many times; give them room.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const BASE = "/api/v1/purchasing";
const FUTURE_EXPIRY = new Date(Date.now() + 365 * 86_400_000);

const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

let cookie: string;
let userId: string;

let groupId: string;
let unitId: string;
let locationId: string;

let supplierId: string;
let productId: string; // main PO product (cost 100)
let productBId: string; // second product on the main PO (cost 50)

// Main PO: itemA received 100 @100, itemB received 100 @50
let poId: string;
let itemAId: string;
let itemBId: string;
let batchAId: string;

const createdReturnIds: string[] = [];
const createdInvoiceIds: string[] = [];
const standaloneCleanups: Array<() => Promise<void>> = [];

async function makeStandaloneItem(opts: {
  tag: string;
  productId?: string;
  received?: number;
  unitCost?: number;
}): Promise<{ poId: string; itemId: string; productId: string; batchId: string }> {
  const received = opts.received ?? 100;
  const unitCost = opts.unitCost ?? 100;
  const tag = `${opts.tag}-${suffix}`;
  const prodId =
    opts.productId ??
    (
      await prisma.product.create({
        data: {
          name: `PRP Standalone ${tag}`,
          sku: `PRP-SA-${tag}`,
          productGroupId: groupId,
          units: { create: { unitId, conversionFactor: 1, isBaseUnit: true } },
        },
        select: { id: true },
      })
    ).id;

  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: `RP-ST-${tag}`,
      supplierId,
      status: "RECEIVED",
      createdById: userId,
      items: {
        create: [{ productId: prodId, quantityOrdered: received, unitId, unitCost, quantityOrderedBase: received }],
      },
    },
    include: { items: true },
  });
  const item = po.items[0];
  await prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { quantityReceived: received } });

  const batch = await prisma.batch.create({
    data: {
      productId: prodId,
      batchNumber: `RPB-${tag}`,
      expiryDate: FUTURE_EXPIRY,
      purchaseCost: unitCost,
      supplierId,
    },
  });
  await prisma.inventoryStock.create({
    data: { productId: prodId, batchId: batch.id, locationId, quantity: received },
  });
  const gr = await prisma.goodsReceipt.create({
    data: {
      receiptNumber: `RPGR-${tag}`,
      purchaseOrderId: po.id,
      supplierId,
      status: "MATCHED",
      createdById: userId,
      items: {
        create: [{
          purchaseOrderItemId: item.id,
          locationId,
          expectedQty: received,
          deliveredQty: received,
          actualQty: received,
          unitCost,
          batchId: batch.id,
        }],
      },
    },
  });
  void gr;

  const cleanup = async () => {
    const returns = await prisma.purchaseReturn.findMany({ where: { purchaseOrderItemId: item.id }, select: { id: true } });
    for (const ret of returns) {
      await prisma.auditTrail.deleteMany({ where: { entityId: ret.id } });
      await prisma.stockTransaction.deleteMany({ where: { referenceType: "PurchaseReturn", referenceId: ret.id } });
    }
    await prisma.purchaseReturn.deleteMany({ where: { purchaseOrderItemId: item.id } });
    await prisma.supplierPayment.deleteMany({ where: { supplierInvoice: { purchaseOrderId: po.id } } });
    await prisma.supplierInvoiceItem.deleteMany({ where: { invoice: { purchaseOrderId: po.id } } });
    await prisma.supplierInvoice.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.auditTrail.deleteMany({ where: { entityId: gr.id } });
    await prisma.goodsReceiptItem.deleteMany({ where: { goodsReceiptId: gr.id } });
    await prisma.goodsReceipt.delete({ where: { id: gr.id } }).catch(() => undefined);
    await prisma.purchaseOrderItem.delete({ where: { id: item.id } }).catch(() => undefined);
    await prisma.purchaseOrder.delete({ where: { id: po.id } }).catch(() => undefined);
    await prisma.inventoryStock.deleteMany({ where: { batchId: batch.id } });
    await prisma.stockTransaction.deleteMany({ where: { batchId: batch.id } });
    await prisma.batch.delete({ where: { id: batch.id } }).catch(() => undefined);
    if (!opts.productId) {
      await prisma.productUnit.deleteMany({ where: { productId: prodId } });
      await prisma.product.delete({ where: { id: prodId } }).catch(() => undefined);
    }
  };
  standaloneCleanups.push(cleanup);
  return { poId: po.id, itemId: item.id, productId: prodId, batchId: batch.id };
}

/**
 * Creates a PO-linked invoice with one allocation item and tops the total up
 * to `total` via additionalChargesAmount (goods are derived from allocations).
 */
async function makePoLinkedInvoice(opts: {
  number: string;
  poId: string;
  itemId: string;
  quantity: number;
  unitCost?: number;
  total: number;
}) {
  const goods = opts.quantity * (opts.unitCost ?? 100);
  return supplierInvoiceService.create(
    {
      invoiceNumber: opts.number,
      supplierId,
      purchaseOrderId: opts.poId,
      items: [{ purchaseOrderItemId: opts.itemId, quantity: opts.quantity, unitCost: opts.unitCost }],
      additionalChargesAmount: Math.round((opts.total - goods) * 100) / 100,
    },
    { id: userId },
  );
}

beforeAll(async () => {
  const email = `purchase-return.${suffix}@example.com`;
  const signUp = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: "Return Admin", email, password: "ValidPass1" })
    .expect(200);
  const session = sessionCookie(signUp);
  if (!session) throw new Error("Expected a session cookie after sign up");
  cookie = session;
  userId = signUp.body.user.id as string;

  const group = await prisma.productGroup.create({ data: { name: `PRP Group ${suffix}` } });
  groupId = group.id;
  const unit = await prisma.unit.create({
    data: { name: `PRP Piece ${suffix}`, symbol: `PRP-${suffix.slice(-4)}` },
  });
  unitId = unit.id;
  const location = await prisma.inventoryLocation.create({ data: { name: `PRP Store ${suffix}` } });
  locationId = location.id;

  const supplier = await prisma.supplier.create({ data: { name: `PRP Supplier ${suffix}` } });
  supplierId = supplier.id;

  const product = await prisma.product.create({
    data: {
      name: `PRP Product A ${suffix}`,
      sku: `PRP-A-${suffix}`,
      productGroupId: groupId,
      units: { create: { unitId, conversionFactor: 1, isBaseUnit: true } },
    },
  });
  productId = product.id;
  const productB = await prisma.product.create({
    data: {
      name: `PRP Product B ${suffix}`,
      sku: `PRP-B-${suffix}`,
      productGroupId: groupId,
      units: { create: { unitId, conversionFactor: 1, isBaseUnit: true } },
    },
  });
  productBId = productB.id;

  // Main PO: itemA 100 @100, itemB 100 @50 - both fully received.
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: `RP-PO-${suffix}`,
      supplierId,
      status: "RECEIVED",
      createdById: userId,
      items: {
        create: [
          { productId, quantityOrdered: 100, unitId, unitCost: 100, quantityOrderedBase: 100 },
          { productId: productBId, quantityOrdered: 100, unitId, unitCost: 50, quantityOrderedBase: 100 },
        ],
      },
    },
    include: { items: true },
  });
  poId = po.id;
  const [itemA, itemB] = po.items;
  itemAId = itemA.id;
  itemBId = itemB.id;
  await prisma.purchaseOrderItem.update({ where: { id: itemAId }, data: { quantityReceived: 100 } });
  await prisma.purchaseOrderItem.update({ where: { id: itemBId }, data: { quantityReceived: 100 } });

  const batchA = await prisma.batch.create({
    data: { productId, batchNumber: `RPBA-${suffix}`, expiryDate: FUTURE_EXPIRY, purchaseCost: 100, supplierId },
  });
  batchAId = batchA.id;
  await prisma.inventoryStock.create({
    data: { productId, batchId: batchAId, locationId, quantity: 100 },
  });
  const batchB = await prisma.batch.create({
    data: { productId: productBId, batchNumber: `RPBB-${suffix}`, expiryDate: FUTURE_EXPIRY, purchaseCost: 50, supplierId },
  });
  await prisma.inventoryStock.create({
    data: { productId: productBId, batchId: batchB.id, locationId, quantity: 100 },
  });
  for (const [item, batch, qty] of [
    [itemA, batchA, 100],
    [itemB, batchB, 100],
  ] as const) {
    await prisma.goodsReceipt.create({
      data: {
        receiptNumber: `RPGR-A-${suffix}-${item.id.slice(0, 4)}`,
        purchaseOrderId: poId,
        supplierId,
        status: "MATCHED",
        createdById: userId,
        items: {
          create: [{
            purchaseOrderItemId: item.id,
            locationId,
            expectedQty: qty,
            deliveredQty: qty,
            actualQty: qty,
            unitCost: item.id === itemAId ? 100 : 50,
            batchId: batch.id,
          }],
        },
      },
    });
  }
});

afterAll(async () => {
  for (const cleanup of standaloneCleanups) {
    await cleanup().catch(() => undefined);
  }
  // Main PO cleanup: returns first (RESTRICT on purchase_order_item), then
  // invoices/payments, receipts, stock, batches, products, supplier...
  const mainItemIds = [itemAId, itemBId].filter(Boolean);
  for (const itemId of mainItemIds) {
    const returns = await prisma.purchaseReturn.findMany({ where: { purchaseOrderItemId: itemId }, select: { id: true } });
    for (const ret of returns) {
      await prisma.auditTrail.deleteMany({ where: { entityId: ret.id } });
      await prisma.stockTransaction.deleteMany({ where: { referenceType: "PurchaseReturn", referenceId: ret.id } });
    }
    await prisma.purchaseReturn.deleteMany({ where: { purchaseOrderItemId: itemId } });
  }
  if (poId) {
    await prisma.supplierPayment.deleteMany({ where: { supplierInvoice: { purchaseOrderId: poId } } });
    await prisma.supplierInvoiceItem.deleteMany({ where: { invoice: { purchaseOrderId: poId } } });
    await prisma.supplierInvoice.deleteMany({ where: { purchaseOrderId: poId } });
    await prisma.goodsReceiptItem.deleteMany({ where: { goodsReceipt: { purchaseOrderId: poId } } });
    await prisma.goodsReceipt.deleteMany({ where: { purchaseOrderId: poId } });
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: poId } });
    await prisma.purchaseOrder.delete({ where: { id: poId } }).catch(() => undefined);
  }
  for (const invoiceId of createdInvoiceIds) {
    await prisma.supplierPayment.deleteMany({ where: { supplierInvoiceId: invoiceId } });
    await prisma.supplierInvoice.deleteMany({ where: { id: invoiceId } }).catch(() => undefined);
  }
  await prisma.auditTrail.deleteMany({
    where: { entityId: { in: [...createdReturnIds, ...createdInvoiceIds] } },
  });
  const productIds = [productId, productBId].filter(Boolean);
  if (productIds.length) {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }
  if (supplierId) await prisma.supplier.delete({ where: { id: supplierId } }).catch(() => undefined);
  if (locationId) await prisma.inventoryLocation.delete({ where: { id: locationId } }).catch(() => undefined);
  if (unitId) await prisma.unit.delete({ where: { id: unitId } }).catch(() => undefined);
  if (groupId) await prisma.productGroup.delete({ where: { id: groupId } }).catch(() => undefined);
  await prisma.$disconnect();
});

async function createReturn(overrides: Record<string, unknown>) {
  const created = await purchaseReturnService.create(
    {
      supplierId,
      productId,
      purchaseOrderItemId: itemAId,
      locationId,
      reason: "DAMAGED",
      quantity: 1,
      ...overrides,
    } as Parameters<typeof purchaseReturnService.create>[0],
    { id: userId },
  );
  createdReturnIds.push(created.id);
  return created;
}

describe("purchase return -> payable linkage (integration)", () => {
  it("derives the return value from the PO item cost and rejects a tampered cost", async () => {
    const created = await createReturn({ quantity: 10 });
    // 10 base units x 100 ETB per base unit.
    expect(Number(created.debitNoteAmount)).toBe(1000);
    expect(Number(created.unitCost)).toBe(100);
    expect(created.purchaseOrderItemId).toBe(itemAId);

    await expect(
      createReturn({ quantity: 1, unitCost: 999 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      createReturn({ quantity: 1, debitNoteAmount: 5 }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // The rejected tampered attempts created no return rows.
    const count = await prisma.purchaseReturn.count({ where: { purchaseOrderItemId: itemAId } });
    expect(count).toBe(1);
  });

  it("caps returns at received minus previous returns and reports returnable quantity", async () => {
    // Standalone item so the arithmetic is not affected by other tests
    // sharing the main PO's itemA returnable pool.
    const standalone = await makeStandaloneItem({ tag: "CAP", received: 100 });
    const before = await getReturnableState(standalone.itemId, supplierId);
    expect(Number(before.returnable)).toBe(100);

    await createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 20 });
    await createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 30 });

    const afterTwo = await getReturnableState(standalone.itemId, supplierId);
    expect(Number(afterTwo.returnable)).toBe(50);

    // A third return that would exceed the remaining cap is rejected.
    await expect(
      createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 51 }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "PURCHASE_RETURN_EXCEEDS_RETURNABLE",
    });
    const state = await getReturnableState(standalone.itemId, supplierId);
    expect(Number(state.returnable)).toBe(50);
    await expect(
      createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 51 }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "PURCHASE_RETURN_EXCEEDS_RETURNABLE",
    });
  });

  it("records the RETURN_TO_SUPPLIER stock movement and decreases stock", async () => {
    const stockBefore = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId: batchAId, locationId } },
      select: { quantity: true },
    });
    const created = await createReturn({ quantity: 10 });
    const movement = await prisma.stockTransaction.findFirst({
      where: { referenceType: "PurchaseReturn", referenceId: created.id },
    });
    expect(movement).not.toBeNull();
    expect(movement?.transactionType).toBe("RETURN_TO_SUPPLIER");
    expect(movement?.direction).toBe("OUT");
    expect(movement?.batchId).toBe(batchAId);
    expect(movement?.locationId).toBe(locationId);
    expect(Number(movement?.quantity)).toBe(10);
    const stockAfter = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId: batchAId, locationId } },
      select: { quantity: true },
    });
    expect(Number(stockAfter?.quantity)).toBe(Number(stockBefore?.quantity) - 10);
  });

  it("lets an early return reduce the payable so a later payment cannot exceed it (unpaid case)", async () => {
    // Return 20 units @100 = 2,000 BEFORE any invoice exists (pending credit),
    // then create a PO-linked invoice totalling 10,000 - the pending credit
    // must reduce its opening outstanding to 8,000.
    const standalone = await makeStandaloneItem({ tag: "EARLY" });
    await createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 20 });
    const pending = await prisma.purchaseReturn.findFirst({
      where: { purchaseOrderItemId: standalone.itemId },
      select: { debitNoteAmount: true, appliedToPayable: true },
    });
    expect(Number(pending?.debitNoteAmount)).toBe(2000);
    expect(Number(pending?.appliedToPayable)).toBe(0); // nothing outstanding yet

    const invoice = await makePoLinkedInvoice({
      number: `RP-EARLY-INV-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 40,
      total: 10_000,
    });
    createdInvoiceIds.push(invoice.id);
    expect(Number(invoice.totalAmount)).toBe(10_000);
    expect(Number(invoice.outstandingBalance)).toBe(8_000);

    // Payment of the reduced balance settles the invoice; paying more fails.
    const payment = await supplierInvoiceService.recordPayment(invoice.id, { amount: 8_000 }, { id: userId });
    expect(Number(payment.amount)).toBe(8_000);
    await expect(
      supplierInvoiceService.recordPayment(invoice.id, { amount: 1 }, { id: userId }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const settled = await prisma.supplierInvoice.findUnique({
      where: { id: invoice.id },
      select: { outstandingBalance: true, status: true, totalAmount: true },
    });
    expect(Number(settled?.outstandingBalance)).toBe(0);
    expect(settled?.status).toBe("PAID");
    // The original invoice total is untouched - history intact.
    expect(Number(settled?.totalAmount)).toBe(10_000);
  });

  it("applies a return against a partially paid invoice without double counting", async () => {
    const standalone = await makeStandaloneItem({ tag: "PARTIAL" });
    const invoice = await makePoLinkedInvoice({
      number: `RP-PART-INV-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 100,
      total: 10_000,
    });
    createdInvoiceIds.push(invoice.id);
    expect(Number(invoice.outstandingBalance)).toBe(10_000);

    await supplierInvoiceService.recordPayment(invoice.id, { amount: 6_000 }, { id: userId });

    const ret = await createReturn({
      purchaseOrderItemId: standalone.itemId,
      productId: standalone.productId,
      quantity: 10,
    });
    expect(Number(ret.debitNoteAmount)).toBe(1_000);
    expect(Number(ret.appliedToPayable)).toBe(1_000); // fully applicable

    const after = await prisma.supplierInvoice.findUnique({
      where: { id: invoice.id },
      select: { outstandingBalance: true, status: true },
    });
    expect(Number(after?.outstandingBalance)).toBe(3_000); // 10,000 - 6,000 - 1,000
    expect(after?.status).toBe("PARTIALLY_PAID");

    // Original payment record is untouched.
    const payments = await prisma.supplierPayment.findMany({
      where: { supplierInvoiceId: invoice.id },
      select: { amount: true },
    });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount)).toBe(6_000);
  });

  it("keeps the unapplied remainder as supplier refund/credit when invoices are fully paid", async () => {
    const standalone = await makeStandaloneItem({ tag: "FULLPAID" });
    const invoice = await makePoLinkedInvoice({
      number: `RP-FULL-INV-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 100,
      total: 10_000,
    });
    createdInvoiceIds.push(invoice.id);
    await supplierInvoiceService.recordPayment(invoice.id, { amount: 10_000 }, { id: userId });

    const ret = await createReturn({
      purchaseOrderItemId: standalone.itemId,
      productId: standalone.productId,
      quantity: 10,
    });
    expect(Number(ret.debitNoteAmount)).toBe(1_000);
    // Nothing outstanding -> nothing applied; the whole value is credit.
    expect(Number(ret.appliedToPayable)).toBe(0);

    const after = await prisma.supplierInvoice.findUnique({
      where: { id: invoice.id },
      select: { outstandingBalance: true, status: true, totalAmount: true },
    });
    expect(Number(after?.outstandingBalance)).toBe(0);
    expect(after?.status).toBe("PAID");
    expect(Number(after?.totalAmount)).toBe(10_000); // never rewritten

    // Finance effect: debitNoteAmount - appliedToPayable = refund/credit.
    expect(Number(ret.debitNoteAmount) - Number(ret.appliedToPayable)).toBe(1_000);
  });

  it("splits the applied value across the PO's multiple invoices oldest-first", async () => {
    const standalone = await makeStandaloneItem({ tag: "SPLIT" });
    const invoice1 = await makePoLinkedInvoice({
      number: `RP-SPLIT-INV1-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 30,
      total: 3_000,
    });
    const invoice2 = await makePoLinkedInvoice({
      number: `RP-SPLIT-INV2-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 40,
      total: 4_000,
    });
    createdInvoiceIds.push(invoice1.id, invoice2.id);

    const ret = await createReturn({
      purchaseOrderItemId: standalone.itemId,
      productId: standalone.productId,
      quantity: 5,
    });
    expect(Number(ret.debitNoteAmount)).toBe(500);
    expect(Number(ret.appliedToPayable)).toBe(500);

    const first = await prisma.supplierInvoice.findUnique({
      where: { id: invoice1.id },
      select: { outstandingBalance: true, status: true },
    });
    const second = await prisma.supplierInvoice.findUnique({
      where: { id: invoice2.id },
      select: { outstandingBalance: true, status: true },
    });
    expect(Number(first?.outstandingBalance)).toBe(2_500);
    expect(first?.status).toBe("PARTIALLY_PAID");
    expect(Number(second?.outstandingBalance)).toBe(4_000);
  });

  it("retries with the same idempotency key return the original return without duplication", async () => {
    const standalone = await makeStandaloneItem({ tag: "IDEM" });
    const key = `idem-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const first = await createReturn({
      purchaseOrderItemId: standalone.itemId,
      productId: standalone.productId,
      quantity: 5,
      idempotencyKey: key,
    });
    const replay = await createReturn({
      purchaseOrderItemId: standalone.itemId,
      productId: standalone.productId,
      quantity: 5,
      idempotencyKey: key,
    });
    expect(replay.id).toBe(first.id);

    const movements = await prisma.stockTransaction.findMany({
      where: { referenceType: "PurchaseReturn", referenceId: first.id },
    });
    expect(movements).toHaveLength(1);

    const state = await getReturnableState(standalone.itemId, supplierId);
    expect(Number(state.previouslyReturned)).toBe(5);
  });

  it("rejects concurrent returns that jointly exceed the returnable quantity", async () => {
    const standalone = await makeStandaloneItem({ tag: "CONC", received: 60 });
    const results = await Promise.allSettled([
      createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 40 }),
      createReturn({ purchaseOrderItemId: standalone.itemId, productId: standalone.productId, quantity: 40 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "PURCHASE_RETURN_EXCEEDS_RETURNABLE",
    });
    const total = await prisma.purchaseReturn.aggregate({
      where: { purchaseOrderItemId: standalone.itemId },
      _sum: { quantity: true },
    });
    expect(Number(total._sum.quantity)).toBe(40);
  });

  it("rolls back return, movement and balance changes when the movement fails", async () => {
    const standalone = await makeStandaloneItem({ tag: "ROLLBACK" });
    const invoice = await makePoLinkedInvoice({
      number: `RP-ROLL-INV-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 100,
      total: 10_000,
    });
    createdInvoiceIds.push(invoice.id);

    // An empty location makes the stock movement fail inside the transaction.
    const emptyLocation = await prisma.inventoryLocation.create({
      data: { name: `PRP Empty ${suffix}` },
    });
    try {
      await expect(
        purchaseReturnService.create(
          {
            supplierId,
            productId: standalone.productId,
            purchaseOrderItemId: standalone.itemId,
            locationId: emptyLocation.id,
            reason: "DAMAGED",
            quantity: 10,
          },
          { id: userId },
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Nothing leaked: no return row, no movement, balance unchanged.
      const returns = await prisma.purchaseReturn.findMany({ where: { purchaseOrderItemId: standalone.itemId } });
      expect(returns).toHaveLength(0);
      const balance = await prisma.supplierInvoice.findUnique({
        where: { id: invoice.id },
        select: { outstandingBalance: true },
      });
      expect(Number(balance?.outstandingBalance)).toBe(10_000);
    } finally {
      await prisma.inventoryLocation.delete({ where: { id: emptyLocation.id } }).catch(() => undefined);
    }
  });

  it("ignores fully settled invoices in payment reminders", async () => {
    const standalone = await makeStandaloneItem({ tag: "REMIND" });
    const invoice = await makePoLinkedInvoice({
      number: `RP-REM-INV-${suffix}`,
      poId: standalone.poId,
      itemId: standalone.itemId,
      quantity: 50,
      total: 5_000,
    });
    createdInvoiceIds.push(invoice.id);
    const reminderBefore = await notificationService.findInvoicesNeedingReminders();
    const hadBefore = reminderBefore.some((r) => r.invoice.id === invoice.id);

    // A return that settles the outstanding balance stops reminders.
    await createReturn({
      purchaseOrderItemId: standalone.itemId,
      productId: standalone.productId,
      quantity: 50,
    });
    const reminderAfter = await notificationService.findInvoicesNeedingReminders();
    expect(reminderAfter.some((r) => r.invoice.id === invoice.id)).toBe(false);
    void hadBefore;
  });

  it("exposes the linkage through the API and protects returns from deletion", async () => {
    const created = await createReturn({ quantity: 5 });

    const listRes = await request(app)
      .get(`${BASE}/purchase-returns`)
      .set("Cookie", cookie)
      .expect(200);
    const listed = (Array.isArray(listRes.body.data) ? listRes.body.data : listRes.body.data.items).find(
      (i: { id: string }) => i.id === created.id,
    );
    expect(listed).toBeTruthy();
    expect(listed.purchaseOrderItem?.id).toBe(itemAId);
    expect(Number(listed.appliedToPayable)).toBeLessThanOrEqual(Number(listed.debitNoteAmount));

    const detailRes = await request(app)
      .get(`${BASE}/purchase-returns/${created.id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(detailRes.body.data.purchaseOrderItem?.purchaseOrder?.poNumber).toBe(`RP-PO-${suffix}`);

    await request(app).get(`${BASE}/purchase-returns`).expect(401);
    await request(app)
      .delete(`${BASE}/purchase-returns/${created.id}`)
      .set("Cookie", cookie)
      .expect(409);
  });

  it("supports returnable-quantity lookup over the API", async () => {
    const res = await request(app)
      .get(`${BASE}/purchase-order-items/${itemBId}/returnable`)
      .query({ supplierId })
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.purchaseOrderItemId).toBe(itemBId);
    expect(Number(res.body.data.quantityReceived)).toBe(100);
    expect(Number(res.body.data.returnable)).toBe(100);
    expect(Number(res.body.data.unitCost)).toBe(50);
  });
});
