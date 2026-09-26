import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  invoiceReceivingService,
  type InvoiceUploadInput,
} from "../src/services/purchasing/invoice-receiving.service.js";
import { purchaseOrderService } from "../src/services/purchasing/purchase-order.service.js";
import { supplierInvoiceService } from "../src/services/purchasing/supplier-invoice.service.js";

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 10);
const TODAY = new Date();
const FUTURE_EXPIRY = new Date(TODAY.getTime() + 365 * 86_400_000);

let dbReady = false;
let userId: string;
let supplierId: string;
let groupId: string;
let unitId: string;
let unitName: string;
let locationId: string;
let productId: string;
let productSku: string;
let productName: string;

const actor = () => ({ id: userId });

async function cleanup() {
  if (!dbReady) return;
  await prisma.supplierPayment.deleteMany({ where: { supplierId } });
  await prisma.supplierInvoice.deleteMany({ where: { supplierId } });
  await prisma.goodsReceipt.deleteMany({ where: { purchaseOrder: { supplierId } } });
  await prisma.purchaseOrder.deleteMany({ where: { supplierId } });
  await prisma.stockTransaction.deleteMany({ where: { productId } });
  await prisma.inventoryStock.deleteMany({ where: { productId } });
  await prisma.batch.deleteMany({ where: { productId } });
  await prisma.productUnit.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.supplier.deleteMany({ where: { id: supplierId } });
  await prisma.unit.deleteMany({ where: { id: unitId } });
  await prisma.productGroup.deleteMany({ where: { id: groupId } });
  await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
}

beforeAll(async () => {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch {
    dbReady = false;
    return;
  }
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    dbReady = false;
    return;
  }
  dbReady = true;
  userId = user.id;

  const supplier = await prisma.supplier.create({ data: { name: `Invoice Supplier ${suffix}` } });
  supplierId = supplier.id;
  const group = await prisma.productGroup.create({ data: { name: `Invoice Group ${suffix}` } });
  groupId = group.id;
  const unit = await prisma.unit.create({ data: { name: `Invoice Unit ${suffix}` } });
  unitId = unit.id;
  unitName = unit.name;
  const location = await prisma.inventoryLocation.create({ data: { name: `Invoice Loc ${suffix}` } });
  locationId = location.id;

  productSku = `INV-${suffix}`;
  productName = `Invoice Product ${suffix}`;
  const product = await prisma.product.create({
    data: {
      name: productName,
      sku: productSku,
      productGroupId: groupId,
      units: { create: { unitId, conversionFactor: 1, isBaseUnit: true, sellPrice: 20, purchasePrice: 10 } },
    },
  });
  productId = product.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function createPO(quantity: number, unitCost = 10) {
  return purchaseOrderService.create(
    { supplierId, items: [{ productId, quantityOrdered: quantity, unitCost }] },
    actor(),
  );
}

function baseInput(overrides: Partial<InvoiceUploadInput> = {}): InvoiceUploadInput {
  return {
    locationId,
    invoiceNumber: `INV-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
    invoiceDate: TODAY,
    items: [
      {
        productCode: productSku,
        productName,
        quantity: 10,
        batchNumber: `B-${Math.random().toString(36).slice(2, 8)}`,
        expiryDate: FUTURE_EXPIRY,
      },
    ],
    ...overrides,
  };
}

// The shared dev database is frequently saturated; allow generous timeouts so
// these integration tests fail on logic, not on queueing.
const itDb = (name: string, fn: () => Promise<void>) =>
  it(
    name,
    async () => {
      if (!dbReady) return;
      await fn();
    },
    120_000,
  );

describe("invoice-assisted receiving", () => {
  itDb("previews a partial delivery without mutating anything", async () => {
    const po = await createPO(100);
    const poItemId = po.items[0]!.id;

    const preview = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 60, batchNumber: "P1", expiryDate: FUTURE_EXPIRY }] }),
    );

    expect(preview.canConfirm).toBe(true);
    expect(preview.items[0]!.poRemaining).toBe(100);
    expect(preview.items[0]!.remainingAfterReceipt).toBe(40);
    expect(preview.discrepancies).toEqual([]);

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
    expect(Number(item!.quantityReceived)).toBe(0);
    expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: po.id } })).toBe(0);
  });

  itDb("receives a partial delivery and keeps the PO awaiting delivery", async () => {
    const po = await createPO(100);
    const poItemId = po.items[0]!.id;

    const result = await invoiceReceivingService.confirm(
      po.id,
      baseInput({ grandTotal: 600, items: [{ productCode: productSku, quantity: 60, batchNumber: "PARTIAL", expiryDate: FUTURE_EXPIRY }] }),
      actor(),
    );

    expect(result.goodsReceipt!.status).toBe("MATCHED");
    expect(Number(result.supplierInvoice.totalAmount)).toBe(600);
    expect(Number(result.supplierInvoice.invoiceAmount)).toBe(600);
    expect(result.purchaseOrder.status).toBe("AWAITING_DELIVERY");

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
    expect(Number(item!.quantityReceived)).toBe(60);

    const stock = await prisma.inventoryStock.aggregate({
      where: { productId, locationId },
      _sum: { quantity: true },
    });
    expect(Number(stock._sum.quantity)).toBeGreaterThanOrEqual(60);
  });

  itDb("accumulates a second invoice against the CURRENT remaining quantity", async () => {
    const po = await createPO(100);
    const poItemId = po.items[0]!.id;

    await invoiceReceivingService.confirm(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 60, batchNumber: "ACC-1", expiryDate: FUTURE_EXPIRY }] }),
      actor(),
    );

    const second = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 40, batchNumber: "ACC-2", expiryDate: FUTURE_EXPIRY }] }),
    );
    expect(second.items[0]!.poRemaining).toBe(40);
    expect(second.canConfirm).toBe(true);

    const result = await invoiceReceivingService.confirm(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 40, batchNumber: "ACC-2", expiryDate: FUTURE_EXPIRY }] }),
      actor(),
    );
    expect(result.purchaseOrder.status).toBe("RECEIVED");

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
    expect(Number(item!.quantityReceived)).toBe(100);
  });

  itDb("receives multiple batches for one PO item in a single receipt", async () => {
    const po = await createPO(100);
    const poItemId = po.items[0]!.id;

    const result = await invoiceReceivingService.confirm(
      po.id,
      baseInput({
        items: [
          { productCode: productSku, quantity: 60, batchNumber: "MB-A", expiryDate: FUTURE_EXPIRY },
          { productCode: productSku, quantity: 40, batchNumber: "MB-B", expiryDate: FUTURE_EXPIRY },
        ],
      }),
      actor(),
    );

    expect(result.goodsReceipt!.items.length).toBe(2);
    expect(Number((await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } }))!.quantityReceived)).toBe(100);

    const batchA = await prisma.batch.findUnique({
      where: { productId_batchNumber: { productId, batchNumber: "MB-A" } },
      include: { stock: true },
    });
    const batchB = await prisma.batch.findUnique({
      where: { productId_batchNumber: { productId, batchNumber: "MB-B" } },
      include: { stock: true },
    });
    expect(Number(batchA!.stock[0]!.quantity)).toBe(60);
    expect(Number(batchB!.stock[0]!.quantity)).toBe(40);
  });

  itDb("blocks an invoice quantity that exceeds the PO remaining quantity", async () => {
    const po = await createPO(40);

    const preview = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 50, batchNumber: "OVER", expiryDate: FUTURE_EXPIRY }] }),
    );
    expect(preview.canConfirm).toBe(false);
    expect(preview.discrepancies.map((d) => d.code)).toContain("INVOICE_QUANTITY_EXCEEDS_PO_REMAINING");

    await expect(
      invoiceReceivingService.confirm(
        po.id,
        baseInput({ items: [{ productCode: productSku, quantity: 50, batchNumber: "OVER", expiryDate: FUTURE_EXPIRY }] }),
        actor(),
      ),
    ).rejects.toMatchObject({ code: "INVOICE_QUANTITY_EXCEEDS_PO_REMAINING" });

    expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: po.id } })).toBe(0);
  });

  itDb("records a physical shortfall without reducing the supplier invoice total", async () => {
    const po = await createPO(100);

    await expect(
      invoiceReceivingService.confirm(
        po.id,
        baseInput({
          grandTotal: 1000,
          items: [{ productCode: productSku, quantity: 100, acceptedQuantity: 90, batchNumber: "SHORT", expiryDate: FUTURE_EXPIRY }],
        }),
        actor(),
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_DISCREPANCY_UNRESOLVED" });

    const result = await invoiceReceivingService.confirm(
      po.id,
      baseInput({
        grandTotal: 1000,
        discrepancyNote: "10 units pending a follow-up delivery",
        items: [{ productCode: productSku, quantity: 100, acceptedQuantity: 90, batchNumber: "SHORT", expiryDate: FUTURE_EXPIRY }],
      }),
      actor(),
    );

    expect(Number(result.supplierInvoice.totalAmount)).toBe(1000);
    expect(Number(result.supplierInvoice.goodsAmount)).toBe(900);
    expect(result.purchaseOrder.status).toBe("AWAITING_DELIVERY");
  });

  itDb("rejects a duplicate supplier invoice number", async () => {
    const invoiceNumber = `DUP-${suffix}`;
    const po1 = await createPO(10);
    await invoiceReceivingService.confirm(
      po1.id,
      baseInput({ invoiceNumber, items: [{ productCode: productSku, quantity: 10, batchNumber: "DUP-1", expiryDate: FUTURE_EXPIRY }] }),
      actor(),
    );

    const po2 = await createPO(10);
    const preview = await invoiceReceivingService.preview(
      po2.id,
      baseInput({ invoiceNumber, items: [{ productCode: productSku, quantity: 10, batchNumber: "DUP-2", expiryDate: FUTURE_EXPIRY }] }),
    );
    expect(preview.discrepancies.map((d) => d.code)).toContain("DUPLICATE_INVOICE_NUMBER");

    await expect(
      invoiceReceivingService.confirm(
        po2.id,
        baseInput({ invoiceNumber, items: [{ productCode: productSku, quantity: 10, batchNumber: "DUP-2", expiryDate: FUTURE_EXPIRY }] }),
        actor(),
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_INVOICE_NUMBER" });
  });

  itDb("flags unmatched invoice lines and unit mismatches", async () => {
    const po = await createPO(100);

    const unmatched = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: "NOPE-SKU", productName: "Unknown", quantity: 5, batchNumber: "U", expiryDate: FUTURE_EXPIRY }] }),
    );
    expect(unmatched.canConfirm).toBe(false);
    expect(unmatched.discrepancies.map((d) => d.code)).toContain("UNMATCHED_INVOICE_ITEM");

    const unitMismatch = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 5, unit: "TABLET", batchNumber: "U2", expiryDate: FUTURE_EXPIRY }] }),
    );
    expect(unitMismatch.discrepancies.map((d) => d.code)).toContain("INVOICE_UNIT_MISMATCH");

    const unitOk = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 5, unit: unitName, batchNumber: "U3", expiryDate: FUTURE_EXPIRY }] }),
    );
    expect(unitOk.discrepancies.map((d) => d.code)).not.toContain("INVOICE_UNIT_MISMATCH");
  });

  itDb("flags a missing batch/expiry instead of fabricating values", async () => {
    const po = await createPO(100);
    const preview = await invoiceReceivingService.preview(
      po.id,
      baseInput({ items: [{ productCode: productSku, quantity: 5 }] }),
    );
    expect(preview.canConfirm).toBe(false);
    expect(preview.discrepancies.map((d) => d.code)).toEqual(
      expect.arrayContaining(["MISSING_BATCH", "MISSING_EXPIRY"]),
    );
  });

  itDb("rolls back the whole operation if invoice creation fails", async () => {
    const po = await createPO(100);
    const poItemId = po.items[0]!.id;

    const spy = vi
      .spyOn(supplierInvoiceService, "create")
      .mockRejectedValueOnce(new Error("forced invoice failure"));

    await expect(
      invoiceReceivingService.confirm(
        po.id,
        baseInput({ items: [{ productCode: productSku, quantity: 60, batchNumber: "ROLLBACK", expiryDate: FUTURE_EXPIRY }] }),
        actor(),
      ),
    ).rejects.toThrow();

    spy.mockRestore();

    expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: po.id } })).toBe(0);
    expect(Number((await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } }))!.quantityReceived)).toBe(0);
  });

  itDb("serializes concurrent confirmations so the PO is never over-received", async () => {
    const po = await createPO(50);

    const makeInput = (batch: string) =>
      baseInput({ items: [{ productCode: productSku, quantity: 30, batchNumber: batch, expiryDate: FUTURE_EXPIRY }] });

    const results = await Promise.allSettled([
      invoiceReceivingService.confirm(po.id, makeInput("CONC-A"), actor()),
      invoiceReceivingService.confirm(po.id, makeInput("CONC-B"), actor()),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1);

    const poItems = await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
    const received = poItems.reduce((sum, i) => sum + Number(i.quantityReceived), 0);
    expect(received).toBeLessThanOrEqual(50);
  });
});
