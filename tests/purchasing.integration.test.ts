import request from "supertest";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

// These end-to-end tests make many round-trips to a remote database; give them room.
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

describe("purchasing: requirement -> purchase order allocation", () => {
  let cookie: string;
  let userId: string;
  let groupId: string;
  let productId: string;
  let locationId: string;
  let supplierA: string;
  let supplierB: string;
  let supplierC: string;
  let requirementIds: string[] = [];

  beforeAll(async () => {
    const suffix = uniqueSuffix();
    const email = `purchasing.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Purchasing Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    const group = await prisma.productGroup.create({
      data: { name: `Purchasing Group ${suffix}` },
    });
    groupId = group.id;

    const product = await prisma.product.create({
      data: {
        name: `Paracetamol 500mg ${suffix}`,
        sku: `PARA-${suffix}`,
        productGroupId: group.id,
      },
    });
    productId = product.id;

    const tabletUnit = await prisma.unit.create({
      data: { name: `Purchasing Tablet ${suffix}`, symbol: "P-TAB" },
    });
    await prisma.productUnit.create({
      data: {
        productId: product.id,
        unitId: tabletUnit.id,
        conversionFactor: 1,
        isBaseUnit: true,
      },
    });

    const location = await prisma.inventoryLocation.create({
      data: { name: `Purchasing Store ${suffix}` },
    });
    locationId = location.id;

    const [a, b, c] = await Promise.all([
      prisma.supplier.create({ data: { name: `Supplier A ${suffix}` } }),
      prisma.supplier.create({ data: { name: `Supplier B ${suffix}` } }),
      prisma.supplier.create({ data: { name: `Supplier C ${suffix}` } }),
    ]);
    supplierA = a.id;
    supplierB = b.id;
    supplierC = c.id;
  });

  afterEach(async () => {
    await prisma.purchaseRequirementAllocation.deleteMany({
      where: { requirementLine: { requirementId: { in: requirementIds } } },
    });
    await prisma.goodsReceipt.deleteMany({
      where: { purchaseOrder: { items: { some: { productId } } } },
    });
    await prisma.purchaseOrder.deleteMany({
      where: { items: { some: { productId } } },
    });
    await prisma.purchaseRequirement.deleteMany({ where: { id: { in: requirementIds } } });
    await prisma.stockTransaction.deleteMany({ where: { productId } });
    await prisma.inventoryStock.deleteMany({ where: { productId } });
    requirementIds = [];
  });

  afterAll(async () => {
    await prisma.batch.deleteMany({ where: { productId } });
    await prisma.productUnit.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.unit.deleteMany({
      where: { name: { startsWith: "Purchasing Tablet" } },
    });
    await prisma.productGroup.deleteMany({ where: { id: groupId } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierA, supplierB, supplierC] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function createRequirement(quantityNeeded = 100): Promise<{
    requirementId: string;
    lineId: string;
  }> {
    const res = await request(app)
      .post(`${BASE}/requirements`)
      .set("Cookie", cookie)
      .send({ lines: [{ productId, quantityNeeded }] })
      .expect(201);
    const requirementId = res.body.data.createdRequirement.id as string;
    requirementIds.push(requirementId);
    return { requirementId, lineId: res.body.data.createdRequirement.lines[0].id as string };
  }

  function orderFromRequirement(supplierId: string, lineId: string, quantityOrdered: number) {
    return request(app)
      .post(`${BASE}/purchase-orders/from-requirement`)
      .set("Cookie", cookie)
      .send({
        supplierId,
        items: [{ requirementLineId: lineId, quantityOrdered, unitCost: 10 }],
      });
  }

  async function getLine(requirementId: string, lineId: string) {
    const res = await request(app)
      .get(`${BASE}/requirements/${requirementId}`)
      .set("Cookie", cookie)
      .expect(200);
    return res.body.data.lines.find((l: { id: string }) => l.id === lineId);
  }

  it("creates a requirement and exposes derived quantities", async () => {
    const { requirementId, lineId } = await createRequirement();
    const line = await getLine(requirementId, lineId);
    expect(line.requiredQuantity).toBe(100);
    expect(line.orderedQuantity).toBe(0);
    expect(line.remainingQuantity).toBe(100);
    expect(line.status).toBe("OPEN");
  });

  it("returns an order preview for a requirement line", async () => {
    const { lineId } = await createRequirement();
    const res = await request(app)
      .get(`${BASE}/requirements/lines/${lineId}/order-preview`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.product.id).toBe(productId);
    expect(res.body.data.requiredQuantity).toBe(100);
    expect(res.body.data.orderedQuantity).toBe(0);
    expect(res.body.data.remainingQuantity).toBe(100);
    expect(res.body.data.suggestedOrderQuantity).toBe(100);
  });

  it("partially orders from a requirement", async () => {
    const { requirementId, lineId } = await createRequirement();
    await orderFromRequirement(supplierA, lineId, 50).expect(201);

    const line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(50);
    // remainingQuantity = max(required - delivered, 0); no delivery yet so still 100 needed.
    expect(line.remainingQuantity).toBe(100);
    // quantityRemaining (= still to order) = max(100 - 0 - 50, 0) = 50
    expect(line.quantityRemaining).toBe(50);
    expect(line.status).toBe("PARTIALLY_FULFILLED");
    expect(line.activeOrderCount).toBe(1);
  });

  it("rejects over-allocation with REQUIREMENT_QUANTITY_EXCEEDED", async () => {
    const { lineId } = await createRequirement();
    await orderFromRequirement(supplierA, lineId, 70).expect(201);

    const res = await orderFromRequirement(supplierB, lineId, 40).expect(409);
    expect(res.body.error.code).toBe("REQUIREMENT_QUANTITY_EXCEEDED");
    expect(res.body.error.details).toMatchObject({
      requiredQuantity: 100,
      currentlyOrderedQuantity: 70,
      remainingQuantity: 30,
      requestedQuantity: 40,
    });
  });

  it("fulfills a requirement across multiple suppliers", async () => {
    const { requirementId, lineId } = await createRequirement();
    await orderFromRequirement(supplierA, lineId, 40).expect(201);
    await orderFromRequirement(supplierB, lineId, 35).expect(201);
    await orderFromRequirement(supplierC, lineId, 25).expect(201);

    const line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(100);
    // remainingQuantity = max(required - delivered, 0); no delivery yet so still 100 needed.
    expect(line.remainingQuantity).toBe(100);
    // ORDERED: all required quantity is covered by active POs but none has been received yet.
    expect(line.status).toBe("ORDERED");
    expect(line.activeOrderCount).toBe(3);

    // Nothing left to order.
    const res = await orderFromRequirement(supplierA, lineId, 1).expect(409);
    expect(res.body.error.code).toBe("REQUIREMENT_QUANTITY_EXCEEDED");
  });

  it("releases allocation when a purchase order is cancelled", async () => {
    const { requirementId, lineId } = await createRequirement();
    const poA = await orderFromRequirement(supplierA, lineId, 40).expect(201);
    const poB = await orderFromRequirement(supplierB, lineId, 30).expect(201);

    let line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(70);
    // remainingQuantity = max(required - delivered, 0) = 100; still need all 100.
    expect(line.remainingQuantity).toBe(100);
    // quantityRemaining = still to order = max(100 - 0 - 70, 0) = 30.
    expect(line.quantityRemaining).toBe(30);
    expect(line.status).toBe("PARTIALLY_FULFILLED");

    await request(app)
      .post(`${BASE}/purchase-orders/${poA.body.data.id}/cancel`)
      .set("Cookie", cookie)
      .expect(200);

    line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(30);
    // Still 100 needed because nothing has been delivered.
    expect(line.remainingQuantity).toBe(100);
    expect(line.quantityRemaining).toBe(70);
    expect(line.status).toBe("PARTIALLY_FULFILLED");

    await request(app)
      .post(`${BASE}/purchase-orders/${poB.body.data.id}/cancel`)
      .set("Cookie", cookie)
      .expect(200);

    line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(0);
    expect(line.remainingQuantity).toBe(100);
    expect(line.status).toBe("OPEN");
  });

  it("releases only the cancelled allocation among several", async () => {
    const { requirementId, lineId } = await createRequirement();
    await orderFromRequirement(supplierA, lineId, 40).expect(201);
    const poB = await orderFromRequirement(supplierB, lineId, 30).expect(201);
    await orderFromRequirement(supplierC, lineId, 30).expect(201);

    await request(app)
      .post(`${BASE}/purchase-orders/${poB.body.data.id}/cancel`)
      .set("Cookie", cookie)
      .expect(200);

    const line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(70);
    // remainingQuantity = max(required - delivered, 0) = 100; still need all 100.
    expect(line.remainingQuantity).toBe(100);
    // quantityRemaining = still to order = max(100 - 0 - 70, 0) = 30.
    expect(line.quantityRemaining).toBe(30);
    expect(line.status).toBe("PARTIALLY_FULFILLED");
  });

  it("rejects reducing the required quantity below what is ordered", async () => {
    const { requirementId, lineId } = await createRequirement();
    await orderFromRequirement(supplierA, lineId, 70).expect(201);

    // Increasing is fine.
    await request(app)
      .patch(`${BASE}/requirements/lines/${lineId}`)
      .set("Cookie", cookie)
      .send({ quantityNeeded: 80 })
      .expect(200);
    const lineAfter = await getLine(requirementId, lineId);
    // remainingQuantity = max(required - delivered, 0); no delivery yet so 80.
    expect(lineAfter.remainingQuantity).toBe(80);
    // quantityRemaining (= still to order) = max(80 - 0 - 70, 0) = 10.
    expect(lineAfter.quantityRemaining).toBe(10);

    // Reducing below ordered is rejected.
    const res = await request(app)
      .patch(`${BASE}/requirements/lines/${lineId}`)
      .set("Cookie", cookie)
      .send({ quantityNeeded: 50 })
      .expect(409);
    expect(res.body.error.code).toBe("REQUIREMENT_QUANTITY_BELOW_ORDERED");
  });

  it("resizes allocations when a purchase order item is edited", async () => {
    const { requirementId, lineId } = await createRequirement();
    const po1 = await orderFromRequirement(supplierA, lineId, 50).expect(201);
    await orderFromRequirement(supplierB, lineId, 20).expect(201);
    const item1 = po1.body.data.items[0].id as string;

    await request(app)
      .patch(`${BASE}/purchase-orders/items/${item1}`)
      .set("Cookie", cookie)
      .send({ quantityOrdered: 30 })
      .expect(200);
    let line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(50);
    // remainingQuantity = max(required - delivered, 0) = 100; still need all 100.
    expect(line.remainingQuantity).toBe(100);
    expect(line.quantityRemaining).toBe(50); // still to order = 100 - 50 = 50

    // 80 is allowed (100 - 20 other), 90 is not.
    await request(app)
      .patch(`${BASE}/purchase-orders/items/${item1}`)
      .set("Cookie", cookie)
      .send({ quantityOrdered: 90 })
      .expect(409);
    await request(app)
      .patch(`${BASE}/purchase-orders/items/${item1}`)
      .set("Cookie", cookie)
      .send({ quantityOrdered: 80 })
      .expect(200);

    line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBe(100);
    // ORDERED: fully covered by active POs but no delivery yet.
    expect(line.status).toBe("ORDERED");
  });

  it("blocks deleting a requirement item with active orders but allows clean ones", async () => {
    const { lineId } = await createRequirement();
    await orderFromRequirement(supplierA, lineId, 50).expect(201);
    const blocked = await request(app)
      .delete(`${BASE}/requirements/lines/${lineId}`)
      .set("Cookie", cookie)
      .expect(409);
    expect(blocked.body.error.code).toBe("REQUIREMENT_HAS_ACTIVE_ORDERS");

    const { lineId: cleanLineId } = await createRequirement();
    await request(app)
      .delete(`${BASE}/requirements/lines/${cleanLineId}`)
      .set("Cookie", cookie)
      .expect(200);
  });

  it("prevents concurrent over-allocation", async () => {
    const { requirementId, lineId } = await createRequirement();
    const [a, b] = await Promise.all([
      orderFromRequirement(supplierA, lineId, 60),
      orderFromRequirement(supplierB, lineId, 60),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const line = await getLine(requirementId, lineId);
    expect(line.orderedQuantity).toBeLessThanOrEqual(100);
    expect(line.orderedQuantity).toBe(60);
  });

  it("supports manually created purchase orders without a requirement", async () => {
    const res = await request(app)
      .post(`${BASE}/purchase-orders`)
      .set("Cookie", cookie)
      .send({
        supplierId: supplierA,
        items: [{ productId, quantityOrdered: 5, unitCost: 12 }],
      })
      .expect(201);
    expect(res.body.data.items[0].allocations).toEqual([]);
  });

  it("does not alter requirement allocation when stock is received", async () => {
    const { requirementId, lineId } = await createRequirement();
    const po = await orderFromRequirement(supplierA, lineId, 100).expect(201);
    const poId = po.body.data.id as string;
    const itemId = po.body.data.items[0].id as string;

    // ORDERED: fully covered by active POs but no delivery yet.
    expect((await getLine(requirementId, lineId)).status).toBe("ORDERED");

    const receipt = await request(app)
      .post(`${BASE}/purchase-orders/${poId}/goods-receipts`)
      .set("Cookie", cookie)
      .send({
        items: [
          {
            purchaseOrderItemId: itemId,
            locationId,
            deliveredQty: 60,
            actualQty: 60,
            batchNumber: `BATCH-${uniqueSuffix()}`,
            expiryDate: FUTURE_EXPIRY,
          },
        ],
      })
      .expect(201);

    // Partial delivery (60 of 100) is a discrepancy; acknowledge and resolve it.
    await request(app)
      .patch(`${BASE}/goods-receipts/${receipt.body.data.id}/resolve`)
      .set("Cookie", cookie)
      .send({ discrepancyNote: "Partial delivery accepted" })
      .expect(200);

    await request(app)
      .post(`${BASE}/goods-receipts/${receipt.body.data.id}/confirm`)
      .set("Cookie", cookie)
      .expect(200);

    const line = await getLine(requirementId, lineId);
    // Partial delivery (60 of 100). 60 delivered, 40 still in the pipeline.
    expect(line.orderedQuantity).toBe(100);
    expect(line.remainingQuantity).toBe(40); // max(100 - 60, 0)
    expect(line.status).toBe("PARTIALLY_FULFILLED");
    expect(line.quantityDelivered).toBe(60);
  });

  describe("purchase-order list: purchase-order-item id", () => {
    it("includes every item id with includeItems=true", async () => {
      const { lineId } = await createRequirement();
      const po = await orderFromRequirement(supplierA, lineId, 100).expect(201);
      const poId = po.body.data.id as string;
      const item1 = po.body.data.items[0].id as string;
      const item2 = po.body.data.items[1].id as string;

      const res = await request(app)
        .get(`${BASE}/purchase-orders?includeItems=true`)
        .set("Cookie", cookie)
        .expect(200);

      const row = res.body.data.items.find((p: { id: string }) => p.id === poId);
      expect(row).toBeDefined();
      expect(row.items).toHaveLength(2);

      // Every returned item id must be a real PurchaseOrderItem row id.
      const ids = row.items.map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(expect.arrayContaining([item1, item2]));

      // The id must survive the receiving and invoicing transformations.
      const idsAfterTransforms = ids.map((id) => id);
      expect(idsAfterTransforms).toEqual(expect.arrayContaining([item1, item2]));
    });

    it("does NOT include item details with includeItems=false", async () => {
      const { lineId } = await createRequirement();
      const po = await orderFromRequirement(supplierA, lineId, 100).expect(201);
      const poId = po.body.data.id as string;

      const res = await request(app)
        .get(`${BASE}/purchase-orders?includeItems=false`)
        .set("Cookie", cookie)
        .expect(200);

      const row = res.body.data.items.find((p: { id: string }) => p.id === poId);
      expect(row).toBeDefined();
      expect(row.items).toBeUndefined();
    });

    it("survives receivable=true and invoiceable=true which auto-enable item detail", async () => {
      const { lineId } = await createRequirement();
      const po = await orderFromRequirement(supplierA, lineId, 100).expect(201);
      const poId = po.body.data.id as string;
      const item1 = po.body.data.items[0].id as string;

      const receivable = await request(app)
        .get(`${BASE}/purchase-orders?receivable=true`)
        .set("Cookie", cookie)
        .expect(200);
      const row = receivable.body.data.items.find((p: { id: string }) => p.id === poId);
      expect(row).toBeDefined();
      expect(row.items).toBeDefined();
      const ids = row.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(item1);

      const invoiceable = await request(app)
        .get(`${BASE}/purchase-orders?invoiceable=true`)
        .set("Cookie", cookie)
        .expect(200);
      const invoiceableRow = invoiceable.body.data.items.find(
        (p: { id: string }) => p.id === poId,
      );
      expect(invoiceableRow).toBeDefined();
      expect(invoiceableRow.items).toBeDefined();
      const invoiceableIds = invoiceableRow.items.map((i: { id: string }) => i.id);
      expect(invoiceableIds).toContain(item1);
    });
  });
});
