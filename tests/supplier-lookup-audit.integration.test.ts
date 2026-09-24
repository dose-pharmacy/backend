import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { supplierCatalogService } from "../src/services/purchasing/supplier-catalog.service.js";
import { purchaseReturnService } from "../src/services/purchasing/purchase-return.service.js";
import { productService } from "../src/services/inventory/product.service.js";
import { purchaseOrderService } from "../src/services/purchasing/purchase-order.service.js";
import { goodsReceiptService } from "../src/services/purchasing/goods-receipt.service.js";
import { supplierInvoiceService } from "../src/services/purchasing/supplier-invoice.service.js";
import { saleService } from "../src/services/pos/sale.service.js";
import { stockService } from "../src/services/inventory/stock.service.js";
import { AuditEvent } from "../src/services/audit/audit-events.js";

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 10);
const TODAY = new Date();
const FUTURE_EXPIRY = new Date(TODAY.getTime() + 365 * 86_400_000);
const EXPIRED = new Date(TODAY.getTime() - 30 * 86_400_000);

let dbReady = false;
let userId: string;

let supplierAId: string;
let supplierBId: string;
let groupId: string;
let unitId: string;
let location1Id: string;
let location2Id: string;
let p1Id: string; // ordered from A, batches from A and B
let p2Id: string; // ordered from A, no stock
let p3Id: string; // ordered from B only

let batchA1Id: string; // P1 @ supplier A, stock at L1
let batchA2Id: string; // P1 @ supplier A, stock at L2
let batchB1Id: string; // P1 @ supplier B (must be excluded for A)
let batchA3Id: string; // P2 @ supplier A, zero stock
let batchA1ExpiredId: string; // P1 @ supplier A, expired

async function auditCount(entityId: string, event: string): Promise<number> {
  return prisma.auditTrail.count({ where: { entityId, description: event } });
}

/** Count of a given event across ALL entities (used for before/after deltas). */
async function eventCount(event: string): Promise<number> {
  return prisma.auditTrail.count({ where: { description: event } });
}

async function cleanup() {
  if (!dbReady) return;
  const productIds = [p1Id, p2Id, p3Id].filter(Boolean);

  if (productIds.length) {
    await prisma.sale.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.supplierPayment.deleteMany({ where: { supplierId: { in: [supplierAId, supplierBId].filter(Boolean) } } });
    await prisma.supplierInvoice.deleteMany({ where: { supplierId: { in: [supplierAId, supplierBId].filter(Boolean) } } });
    await prisma.purchaseReturn.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.goodsReceipt.deleteMany({
      where: { purchaseOrder: { supplierId: { in: [supplierAId, supplierBId].filter(Boolean) } } },
    });
    await prisma.purchaseOrder.deleteMany({ where: { supplierId: { in: [supplierAId, supplierBId].filter(Boolean) } } });
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    // Delete every batch for these products: tests also create batches through the
    // real goods-receipt flow, so a fixed id list would leave rows that RESTRICT
    // the product delete.
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }
  if (supplierAId) await prisma.supplier.deleteMany({ where: { id: { in: [supplierAId, supplierBId] } } });
  if (unitId) await prisma.unit.deleteMany({ where: { id: unitId } });
  if (groupId) await prisma.productGroup.deleteMany({ where: { id: groupId } });
  if (location1Id) await prisma.inventoryLocation.deleteMany({ where: { id: { in: [location1Id, location2Id] } } });
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

  const supplierA = await prisma.supplier.create({ data: { name: `Lookup Supplier A ${suffix}` } });
  const supplierB = await prisma.supplier.create({ data: { name: `Lookup Supplier B ${suffix}` } });
  supplierAId = supplierA.id;
  supplierBId = supplierB.id;

  const group = await prisma.productGroup.create({ data: { name: `Lookup Group ${suffix}` } });
  groupId = group.id;
  const unit = await prisma.unit.create({ data: { name: `Lookup Unit ${suffix}` } });
  unitId = unit.id;
  const l1 = await prisma.inventoryLocation.create({ data: { name: `Lookup Loc 1 ${suffix}` } });
  const l2 = await prisma.inventoryLocation.create({ data: { name: `Lookup Loc 2 ${suffix}` } });
  location1Id = l1.id;
  location2Id = l2.id;

  const unitConfig = {
    create: { unitId, conversionFactor: 1, isBaseUnit: true, sellPrice: 10, purchasePrice: 6 },
  };
  const p1 = await prisma.product.create({
    data: {
      name: `Amoxicillin ${suffix}`,
      genericName: "Amoxicillin",
      sku: `AMOX-${suffix}`,
      productGroupId: groupId,
      units: unitConfig,
    },
  });
  const p2 = await prisma.product.create({
    data: {
      name: `Paracetamol ${suffix}`,
      sku: `PARA-${suffix}`,
      productGroupId: groupId,
      units: unitConfig,
    },
  });
  const p3 = await prisma.product.create({
    data: {
      name: `Ibuprofen ${suffix}`,
      sku: `IBU-${suffix}`,
      productGroupId: groupId,
      units: unitConfig,
    },
  });
  p1Id = p1.id;
  p2Id = p2.id;
  p3Id = p3.id;

  // Supplier A ordered P1 and P2; supplier B ordered only P3.
  const poA = await prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-A-${suffix}`,
      supplierId: supplierAId,
      status: "AWAITING_DELIVERY",
      createdById: userId,
      items: {
        create: [
          { productId: p1Id, quantityOrdered: 100, unitId, unitCost: 6 },
          { productId: p2Id, quantityOrdered: 50, unitId, unitCost: 3 },
        ],
      },
    },
    include: { items: true },
  });
  await prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-B-${suffix}`,
      supplierId: supplierBId,
      status: "AWAITING_DELIVERY",
      createdById: userId,
      items: { create: [{ productId: p3Id, quantityOrdered: 20, unitId, unitCost: 4 }] },
    },
  });
  void poA;

  const batchA1 = await prisma.batch.create({
    data: { productId: p1Id, batchNumber: `A1-${suffix}`, expiryDate: FUTURE_EXPIRY, purchaseCost: 6, supplierId: supplierAId },
  });
  const batchA2 = await prisma.batch.create({
    data: { productId: p1Id, batchNumber: `A2-${suffix}`, expiryDate: FUTURE_EXPIRY, purchaseCost: 6, supplierId: supplierAId },
  });
  const batchB1 = await prisma.batch.create({
    data: { productId: p1Id, batchNumber: `B1-${suffix}`, expiryDate: FUTURE_EXPIRY, purchaseCost: 6, supplierId: supplierBId },
  });
  const batchA3 = await prisma.batch.create({
    data: { productId: p2Id, batchNumber: `A3-${suffix}`, expiryDate: FUTURE_EXPIRY, purchaseCost: 3, supplierId: supplierAId },
  });
  const batchA1Expired = await prisma.batch.create({
    data: { productId: p1Id, batchNumber: `A1X-${suffix}`, expiryDate: EXPIRED, purchaseCost: 6, supplierId: supplierAId },
  });
  batchA1Id = batchA1.id;
  batchA2Id = batchA2.id;
  batchB1Id = batchB1.id;
  batchA3Id = batchA3.id;
  batchA1ExpiredId = batchA1Expired.id;

  await prisma.inventoryStock.createMany({
    data: [
      { productId: p1Id, batchId: batchA1Id, locationId: location1Id, quantity: 20, reservedQuantity: 5 },
      { productId: p1Id, batchId: batchA2Id, locationId: location2Id, quantity: 10, reservedQuantity: 0 },
      { productId: p1Id, batchId: batchB1Id, locationId: location1Id, quantity: 7, reservedQuantity: 0 },
      { productId: p2Id, batchId: batchA3Id, locationId: location1Id, quantity: 0, reservedQuantity: 0 },
      { productId: p1Id, batchId: batchA1ExpiredId, locationId: location1Id, quantity: 4, reservedQuantity: 0 },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)("supplier catalog lookup (integration)", () => {
  it("lists only products actually ordered from the supplier", async () => {
    const { items, meta } = await supplierCatalogService.listProductsForSupplier(supplierAId, {
      page: 1,
      limit: 50,
    });
    const ids = items.map((i) => (i as { id: string }).id);
    expect(ids).toContain(p1Id);
    expect(ids).toContain(p2Id);
    // P3 was ordered from supplier B only.
    expect(ids).not.toContain(p3Id);
    expect(meta.total).toBe(2);
    // Response shape carries the fields the UI needs.
    const amox = items.find((i) => (i as { id: string }).id === p1Id) as {
      sku: string;
      isNarcotic: boolean;
    };
    expect(amox.sku).toBe(`AMOX-${suffix}`);
    expect(amox.isNarcotic).toBe(false);

    // Unrelated supplier returns nothing.
    const onlyB = await supplierCatalogService.listProductsForSupplier(supplierBId, { page: 1, limit: 50 });
    expect(onlyB.items.map((i) => (i as { id: string }).id)).toEqual([p3Id]);
  });

  it("supports search and pagination", async () => {
    const searched = await supplierCatalogService.listProductsForSupplier(supplierAId, {
      page: 1,
      limit: 50,
      search: "amox",
    });
    expect(searched.items).toHaveLength(1);
    expect((searched.items[0] as { id: string }).id).toBe(p1Id);

    const page1 = await supplierCatalogService.listProductsForSupplier(supplierAId, { page: 1, limit: 1 });
    const page2 = await supplierCatalogService.listProductsForSupplier(supplierAId, { page: 2, limit: 1 });
    expect(page1.meta.total).toBe(2);
    expect(page1.items[0]).not.toEqual(page2.items[0]);
  });

  it("excludes inactive products by default but can include them", async () => {
    await prisma.product.update({ where: { id: p2Id }, data: { isActive: false } });
    const activeOnly = await supplierCatalogService.listProductsForSupplier(supplierAId, { page: 1, limit: 50 });
    expect(activeOnly.items.map((i) => (i as { id: string }).id)).not.toContain(p2Id);

    const includingInactive = await supplierCatalogService.listProductsForSupplier(supplierAId, {
      page: 1,
      limit: 50,
      isActive: false,
    });
    expect(includingInactive.items.map((i) => (i as { id: string }).id)).toContain(p2Id);
    await prisma.product.update({ where: { id: p2Id }, data: { isActive: true } });
  });

  it("returns only batches owned by the supplier, with per-location available stock", async () => {
    const { items } = await supplierCatalogService.listBatchesForSupplierProduct(supplierAId, p1Id);
    const ids = items.map((i) => (i as { id: string }).id);
    expect(ids).toContain(batchA1Id);
    expect(ids).toContain(batchA2Id);
    // Same product, but received from supplier B -> must not leak in.
    expect(ids).not.toContain(batchB1Id);
    // Expired batch excluded by default.
    expect(ids).not.toContain(batchA1ExpiredId);

    const a1 = items.find((i) => (i as { id: string }).id === batchA1Id) as {
      batchNumber: string;
      purchaseCost: number;
      locations: Array<{ locationId: string; availableQuantity: number }>;
    };
    expect(a1.batchNumber).toBe(`A1-${suffix}`);
    // purchaseCost is a Prisma.Decimal at the service layer (serialized to a
    // number in the HTTP envelope).
    expect(Number(a1.purchaseCost)).toBe(6);
    expect(a1.locations).toEqual([{ locationId: location1Id, locationName: `Lookup Loc 1 ${suffix}`, availableQuantity: 15 }]);
  });

  it("filters batches by location and handles zero-stock batches", async () => {
    const atL2 = await supplierCatalogService.listBatchesForSupplierProduct(supplierAId, p1Id, {
      locationId: location2Id,
    });
    const ids = atL2.items.map((i) => (i as { id: string }).id);
    expect(ids).toEqual([batchA2Id]);

    // P2's only batch from A has zero quantity -> excluded while inStock.
    const inStock = await supplierCatalogService.listBatchesForSupplierProduct(supplierAId, p2Id);
    expect(inStock.items).toHaveLength(0);

    const all = await supplierCatalogService.listBatchesForSupplierProduct(supplierAId, p2Id, {
      inStock: false,
    });
    expect(all.items).toHaveLength(1);
    expect((all.items[0] as { id: string }).locations).toEqual([]);
  });

  it("can include expired batches on request", async () => {
    const withExpired = await supplierCatalogService.listBatchesForSupplierProduct(supplierAId, p1Id, {
      excludeExpired: false,
    });
    expect(withExpired.items.map((i) => (i as { id: string }).id)).toContain(batchA1ExpiredId);
  });

  it("rejects unknown supplier or product and wrong product/batch combinations", async () => {
    await expect(
      supplierCatalogService.listBatchesForSupplierProduct(
        "11111111-1111-4111-8111-111111111111",
        p1Id,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      supplierCatalogService.listBatchesForSupplierProduct(
        supplierAId,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // P3 has no batches from A at all.
    const none = await supplierCatalogService.listBatchesForSupplierProduct(supplierAId, p3Id);
    expect(none.items).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("purchase return validation (integration)", () => {
  const baseInput = () => ({
    productId: p1Id,
    locationId: location1Id,
    reason: "DAMAGED" as const,
    quantity: 1,
    unitCost: 6,
  });

  it("rejects a product never ordered from the supplier", async () => {
    await expect(
      purchaseReturnService.create(
        { ...baseInput(), supplierId: supplierAId, productId: p3Id, batchId: undefined },
        { id: userId },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a batch that belongs to another supplier", async () => {
    await expect(
      purchaseReturnService.create(
        { ...baseInput(), supplierId: supplierAId, batchId: batchB1Id },
        { id: userId },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a batch that does not belong to the product", async () => {
    await expect(
      purchaseReturnService.create(
        // batchA3 belongs to P2, not P1
        { ...baseInput(), supplierId: supplierAId, batchId: batchA3Id },
        { id: userId },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a quantity exceeding available stock", async () => {
    await expect(
      purchaseReturnService.create(
        { ...baseInput(), supplierId: supplierAId, batchId: batchA1Id, quantity: 999 },
        { id: userId },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("creates the return, the stock movement and the audit event together", async () => {
    const before = await eventCount(AuditEvent.PURCHASE_RETURN_CREATED);
    const created = await purchaseReturnService.create(
      { ...baseInput(), supplierId: supplierAId, batchId: batchA1Id, quantity: 5 },
      { id: userId },
    );

    const movement = await prisma.stockTransaction.findFirst({
      where: { referenceType: "PurchaseReturn", referenceId: created.id },
      select: { transactionType: true, direction: true, quantity: true },
    });
    expect(movement?.transactionType).toBe("RETURN_TO_SUPPLIER");
    expect(movement?.direction).toBe("OUT");
    expect(movement?.quantity.toNumber()).toBe(5);
    // Movement is committed atomically with the return record.
    expect((created as { batchId: string | null }).batchId).toBe(batchA1Id);

    const audit = await prisma.auditTrail.findFirst({
      where: { entityId: created.id, description: AuditEvent.PURCHASE_RETURN_CREATED },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(userId);
    expect(audit?.newData).toMatchObject({
      supplierId: supplierAId,
      productId: p1Id,
      batchId: batchA1Id,
      locationId: location1Id,
      quantity: 5,
      reason: "DAMAGED",
    });

    // Exactly one new successful audit record, despite the failed attempts above.
    const after = await eventCount(AuditEvent.PURCHASE_RETURN_CREATED);
    expect(after).toBe(before + 1);
  });

  it("does not leave an audit record when the transaction fails", async () => {
    const before = await eventCount(AuditEvent.PURCHASE_RETURN_CREATED);
    await expect(
      purchaseReturnService.create(
        { ...baseInput(), supplierId: supplierAId, batchId: batchA1Id, quantity: 999 },
        { id: userId },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const after = await eventCount(AuditEvent.PURCHASE_RETURN_CREATED);
    expect(after).toBe(before);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("audit trail (integration)", () => {
  it("audits product creation, isNarcotic changes and deactivation", async () => {
    const actor = { id: userId };
    const product = await productService.create(
      {
        name: `Audit Product ${suffix}`,
        sku: `AUD-${suffix}`,
        productGroupId: groupId,
      },
      actor,
    );
    const productId = (product as { id: string }).id;
    expect(await auditCount(productId, AuditEvent.PRODUCT_CREATED)).toBe(1);

    await productService.update(productId, { isNarcotic: true }, actor);
    const narcoticAudit = await prisma.auditTrail.findFirst({
      where: { entityId: productId, description: AuditEvent.PRODUCT_UPDATED },
      orderBy: { createdAt: "desc" },
    });
    expect(narcoticAudit?.newData).toMatchObject({
      field: "isNarcotic",
      oldValue: false,
      newValue: true,
    });

    await productService.update(productId, { isActive: false }, actor);
    expect(await auditCount(productId, AuditEvent.PRODUCT_DEACTIVATED)).toBe(1);

    // cleanup this test product
    await prisma.productUnit.deleteMany({ where: { productId } });
    await prisma.auditTrail.deleteMany({ where: { entityId: productId } });
    await prisma.product.delete({ where: { id: productId } });
  });

  it("audits purchase order creation and cancellation", async () => {
    const actor = { id: userId };
    const po = await purchaseOrderService.create(
      { supplierId: supplierAId, items: [{ productId: p1Id, quantityOrdered: 10, unitCost: 6 }] },
      actor,
    );
    const poId = (po as { id: string }).id;
    expect(await auditCount(poId, AuditEvent.PURCHASE_ORDER_CREATED)).toBe(1);

    await purchaseOrderService.cancel(poId, actor);
    expect(await auditCount(poId, AuditEvent.PURCHASE_ORDER_CANCELLED)).toBe(1);
  });

  it("audits goods receipt confirmation exactly once and rolls back on failure", async () => {
    const actor = { id: userId };
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-GR-${suffix}`,
        supplierId: supplierAId,
        status: "AWAITING_DELIVERY",
        createdById: userId,
        items: { create: [{ productId: p2Id, quantityOrdered: 10, unitId, unitCost: 3 }] },
      },
      include: { items: true },
    });
    const poItem = po.items[0];

    const gr = await goodsReceiptService.create(
      {
        purchaseOrderId: po.id,
        items: [
          {
            purchaseOrderItemId: poItem.id,
            locationId: location1Id,
            deliveredQty: 10,
            actualQty: 10,
            batchNumber: `GR-${suffix}`,
            expiryDate: FUTURE_EXPIRY,
          },
        ],
      },
      actor,
    );
    const grId = (gr as { id: string }).id;
    expect(await auditCount(grId, AuditEvent.GOODS_RECEIPT_CREATED)).toBe(1);

    await goodsReceiptService.confirm(grId, actor);
    expect(await auditCount(grId, AuditEvent.GOODS_RECEIPT_CONFIRMED)).toBe(1);

    // Confirming twice must fail and must NOT add a second audit record.
    await expect(goodsReceiptService.confirm(grId, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(await auditCount(grId, AuditEvent.GOODS_RECEIPT_CONFIRMED)).toBe(1);

    // Batch received for this product is stamped with the PO's supplier.
    const receivedBatch = await prisma.batch.findFirst({
      where: { productId: p2Id, batchNumber: `GR-${suffix}` },
      select: { supplierId: true },
    });
    expect(receivedBatch?.supplierId).toBe(supplierAId);
  });

  it("audits supplier payment recording", async () => {
    const actor = { id: userId };
    const invoice = await supplierInvoiceService.create(
      { invoiceNumber: `INV-${suffix}`, supplierId: supplierAId, goodsAmount: 100 },
      actor,
    );
    const invoiceId = (invoice as { id: string }).id;
    expect(await auditCount(invoiceId, AuditEvent.SUPPLIER_INVOICE_CREATED)).toBe(1);

    const payment = await supplierInvoiceService.recordPayment(
      invoiceId,
      { amount: 40 },
      actor,
    );
    const paymentId = (payment as { id: string }).id;
    const audit = await prisma.auditTrail.findFirst({
      where: { entityId: paymentId, description: AuditEvent.SUPPLIER_PAYMENT_RECORDED },
    });
    expect(audit).not.toBeNull();
    expect(audit?.newData).toMatchObject({ invoiceId, supplierId: supplierAId, amount: 40 });
  });

  it("audits completed POS sales", async () => {
    const actor = { id: userId };
    const sale = await saleService.complete(
      {
        locationId: location1Id,
        items: [{ productId: p1Id, unitId, quantity: 1 }],
        payments: [{ method: "CASH", amount: 10 }],
      },
      actor,
    );
    const saleId = (sale as { id: string }).id;
    const audit = await prisma.auditTrail.findFirst({
      where: { entityId: saleId, description: AuditEvent.SALE_COMPLETED },
    });
    expect(audit).not.toBeNull();
    expect(audit?.newData).toMatchObject({ locationId: location1Id, containsNarcotic: false });
  });

  it("audits stock adjustments atomically with the movement", async () => {
    const actor = { id: userId };
    const result = await stockService.adjustment(
      {
        productId: p1Id,
        batchId: batchA1Id,
        locationId: location1Id,
        direction: "OUT",
        quantity: 1,
        unitId,
        reason: "count correction",
      },
      actor,
    );
    const transactionId = (result as { transaction: { id: string } }).transaction.id;
    const audit = await prisma.auditTrail.findFirst({
      where: { entityId: transactionId, description: AuditEvent.STOCK_ADJUSTMENT_CREATED },
    });
    expect(audit).not.toBeNull();
    expect(audit?.newData).toMatchObject({ productId: p1Id, batchId: batchA1Id, direction: "OUT" });
  });
});
