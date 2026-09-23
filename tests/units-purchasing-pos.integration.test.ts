import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

/**
 * Multi-unit lifecycle: numbers entered in a non-base unit (Box) must flow
 * through requirement -> PO -> GR -> stock/base reports with consistent base
 * snapshots, while the audit/ledger keeps the entered unit. Also covers a
 * Box-unit stock adjustment and a Tablet-unit POS sale.
 *
 * Model (Amoxicillin): Tablet = base (x1), Strip = x10, Box = x100.
 * 5 Box requirement = 500 Tablets; PO 3 Box = 300 Tablets;
 * receive 3 Box -> +300 base; adjust +1 Box -> +100 base; sell 2 Tablets -> -2.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PURCHASING = "/api/v1/purchasing";
const INVENTORY = "/api/v1/inventory";
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

describe("units: purchasing + stock + pos mixed-unit lifecycle", () => {
  let cookie: string;
  let userId: string;
  let groupId: string;
  let productId: string;
  let locationId: string;
  let supplierId: string;
  let tablet: string;
  let strip: string;
  let box: string;
  const unitIds: string[] = [];
  const requirementIds: string[] = [];

  let createdBatchNumber = "";
  let poId = "";
  let poItemId = "";

  const suffix = uniqueSuffix();

  beforeAll(async () => {
    const email = `units-lifecycle.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Units Lifecycle Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    for (const name of ["Tablet", "Strip", "Box"]) {
      const res = await request(app)
        .post(`${INVENTORY}/units`)
        .set("Cookie", cookie)
        .send({ name: `${name} ${suffix}` })
        .expect(201);
      unitIds.push(res.body.data.id as string);
    }
    tablet = unitIds[0];
    strip = unitIds[1];
    box = unitIds[2];

    const group = await request(app)
      .post(`${INVENTORY}/product-groups`)
      .set("Cookie", cookie)
      .send({ name: `Amoxicillin Group ${suffix}` })
      .expect(201);
    groupId = group.body.data.id as string;

    const product = await request(app)
      .post(`${INVENTORY}/products`)
      .set("Cookie", cookie)
      .send({
        name: "Amoxicillin 250mg",
        sku: `AMOX-${suffix}`,
        productGroupId: groupId,
        units: [
          { unitId: tablet, conversionFactor: 1, sellPrice: 2, purchasePrice: 1, isBaseUnit: true },
          { unitId: strip, conversionFactor: 10, sellPrice: 18, purchasePrice: 10 },
          { unitId: box, conversionFactor: 100, sellPrice: 160, purchasePrice: 90 },
        ],
      })
      .expect(201);
    productId = product.body.data.id as string;

    const loc = await request(app)
      .post(`${INVENTORY}/locations`)
      .set("Cookie", cookie)
      .send({ name: `Amoxicillin Store ${suffix}` })
      .expect(201);
    locationId = loc.body.data.id as string;

    const supplier = await request(app)
      .post(`${PURCHASING}/suppliers`)
      .set("Cookie", cookie)
      .send({ name: `Amoxicillin Supplier ${suffix}` })
      .expect(201);
    supplierId = supplier.body.data.id as string;
  });

  afterAll(async () => {
    // Sales first (they reference stock transactions + batches).
    await prisma.sale.deleteMany({ where: { locationId } });
    await prisma.stockTransaction.deleteMany({ where: { productId } });
    await prisma.inventoryStock.deleteMany({ where: { productId } });

    // Purchasing: allocations, receipts, invoices/payments, POs, requirements.
    const poItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { items: { some: { productId } } } },
      select: { id: true, purchaseOrderId: true },
    });
    const poIds = [...new Set(poItems.map((i) => i.purchaseOrderId))];
    const itemIds = poItems.map((i) => i.id);
    await prisma.purchaseRequirementAllocation.deleteMany({
      where: { purchaseOrderItemId: { in: itemIds } },
    });
    await prisma.goodsReceiptItem.deleteMany({
      where: { purchaseOrderItemId: { in: itemIds } },
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
    await prisma.purchaseOrderItem.deleteMany({
      where: { purchaseOrderId: { in: poIds } },
    });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.purchaseRequirementLine.deleteMany({
      where: { requirementId: { in: requirementIds } },
    });
    await prisma.purchaseRequirement.deleteMany({
      where: { id: { in: requirementIds } },
    });

    await prisma.batch.deleteMany({ where: { productId } });
    await prisma.productUnit.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.productGroup.deleteMany({ where: { id: groupId } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function totalBase(): Promise<number> {
    const agg = await prisma.inventoryStock.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    return agg._sum.quantity?.toNumber() ?? 0;
  }

  async function findMovement(
    referenceType: string,
    referenceId: string,
  ): Promise<Awaited<ReturnType<typeof prisma.stockTransaction.findFirst>> | null> {
    return prisma.stockTransaction.findFirst({
      where: { referenceType, referenceId },
    });
  }

  it("stores a Box-unit requirement as 500 base Tablets and views in Boxes", async () => {
    const req = await request(app)
      .post(`${PURCHASING}/requirements`)
      .set("Cookie", cookie)
      .send({
        title: "Monthly amoxicillin",
        lines: [{ productId, quantityNeeded: 5, unitId: box }],
      })
      .expect(201);
    const requirementId = req.body.data.id as string;
    requirementIds.push(requirementId);

    const view = await request(app)
      .get(`${PURCHASING}/requirements/${requirementId}`)
      .set("Cookie", cookie)
      .expect(200);
    const line = view.body.data.lines[0];
    expect(line.quantityNeeded).toBe(5);
    expect(line.unitId).toBe(box);
    expect(line.quantityOrdered).toBe(0);
    expect(line.remainingQuantity).toBe(5);

    // The persisted base snapshot equals 500 Tablets even though the input
    // was expressed in Boxes.
    const persisted = await prisma.purchaseRequirementLine.findFirstOrThrow({
      where: { requirementId, productId },
    });
    expect(persisted.quantityNeededBase.toNumber()).toBe(500);
  });

  it("orders 3 Box against the requirement -> 300 base allocation", async () => {
    const req = await request(app)
      .get(`${PURCHASING}/requirements/${requirementIds[0]}`)
      .set("Cookie", cookie)
      .expect(200);
    const lineId = req.body.data.lines[0].id as string;

    const po = await request(app)
      .post(`${PURCHASING}/purchase-orders`)
      .set("Cookie", cookie)
      .send({
        supplierId,
        items: [
          {
            productId,
            quantityOrdered: 3,
            unitCost: 90,
            unitId: box,
            requirementLineId: lineId,
          },
        ],
      })
      .expect(201);
    poId = po.body.data.id as string;
    poItemId = po.body.data.items[0].id as string;

    const detail = await request(app)
      .get(`${PURCHASING}/purchase-orders/${poId}`)
      .set("Cookie", cookie)
      .expect(200);
    const item = detail.body.data.items[0];
    expect(item.quantityOrdered).toBe(3);
    expect(item.unitId).toBe(box);
    expect(item.quantityOrderedBase).toBe(300);
    expect(item.quantityReceived).toBe(0);

    // Requirement view normalizes the allocation back into Box units.
    const view = await request(app)
      .get(`${PURCHASING}/requirements/${requirementIds[0]}`)
      .set("Cookie", cookie)
      .expect(200);
    const line = view.body.data.lines[0];
    expect(line.quantityOrdered).toBe(3);
    expect(line.remainingQuantity).toBe(2);
  });

  it("receives 3 Box -> +300 base stock, movement carries the Box snapshot", async () => {
    const itemId = poItemId;
    createdBatchNumber = `AMOX-B${uniqueSuffix()}`;

    const receipt = await request(app)
      .post(`${PURCHASING}/purchase-orders/${poId}/goods-receipts`)
      .set("Cookie", cookie)
      .send({
        items: [
          {
            purchaseOrderItemId: itemId,
            locationId,
            deliveredQty: 3,
            actualQty: 3,
            batchNumber: createdBatchNumber,
            expiryDate: FUTURE_EXPIRY,
          },
        ],
      })
      .expect(201);

    await request(app)
      .post(`${PURCHASING}/goods-receipts/${receipt.body.data.id}/confirm`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await totalBase()).toBe(300);

    // Ledger: the movement is base (300) but snapshots the ordered Box unit.
    const movement = await findMovement("GoodsReceipt", receipt.body.data.id);
    expect(movement?.quantity.toNumber()).toBe(300);
    expect(movement?.unitId).toBe(box);
    expect(movement?.conversionFactor?.toNumber()).toBe(100);

    // PO item received in its ordered unit.
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: itemId } });
    expect(item?.quantityReceived.toNumber()).toBe(3);
    expect(item?.quantityOrderedBase.toNumber()).toBe(300);

    // Requirement line counts 3 Box delivered (PO unit), 2 Box remaining.
    const view = await request(app)
      .get(`${PURCHASING}/requirements/${requirementIds[0]}`)
      .set("Cookie", cookie)
      .expect(200);
    const line = view.body.data.lines[0];
    expect(line.quantityDelivered).toBe(3);
    expect(line.remainingQuantity).toBe(2);
  });

  it("adjusts +1 Box -> +100 base with the Box snapshot", async () => {
    const before = await totalBase();
    const batch = await prisma.batch.findFirstOrThrow({
      where: { productId, batchNumber: createdBatchNumber },
    });

    await request(app)
      .post(`${INVENTORY}/stock-adjustments`)
      .set("Cookie", cookie)
      .send({
        productId,
        batchId: batch.id,
        locationId,
        direction: "IN",
        quantity: 1,
        unitId: box,
        reason: "Counted one extra box on shelf",
      })
      .expect(201);

    expect(await totalBase()).toBe(before + 100);

    const adjustment = await prisma.stockTransaction.findFirst({
      where: { transactionType: "ADJUSTMENT_IN", productId },
      orderBy: { createdAt: "desc" },
    });
    expect(adjustment?.quantity.toNumber()).toBe(100);
    expect(adjustment?.unitId).toBe(box);
    expect(adjustment?.conversionFactor?.toNumber()).toBe(100);
  });

  it("sells 2 Tablets -> -2 base with the Tablet snapshot", async () => {
    const before = await totalBase();

    const sale = await request(app)
      .post("/api/v1/pos/sales")
      .set("Cookie", cookie)
      .send({
        locationId,
        items: [{ productId, unitId: tablet, quantity: 2 }],
        payments: [{ method: "CASH", amount: 4 }],
      })
      .expect(201);

    expect(sale.body.data.items[0].baseQuantity).toBe(2);
    expect(sale.body.data.items[0].unitId).toBe(tablet);
    expect(sale.body.data.items[0].conversionFactor).toBe(1);
    expect(await totalBase()).toBe(before - 2);

    const movement = await prisma.stockTransaction.findFirst({
      where: { referenceType: "Sale", referenceId: sale.body.data.id },
    });
    expect(movement?.quantity.toNumber()).toBe(2);
    expect(movement?.unitId).toBe(tablet);
    expect(movement?.conversionFactor?.toNumber()).toBe(1);
  });
});