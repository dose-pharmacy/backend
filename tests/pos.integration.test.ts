import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { UserRole } from "../src/authorization/roles.js";
import { prisma } from "../src/database/prisma.js";
import { saleService } from "../src/services/pos/sale.service.js";
import { stockMovementService } from "../src/services/inventory/stock-movement.service.js";

function uniqueEmail(label: string): string {
  return `${label}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.com`;
}

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) {
    return undefined;
  }
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

async function signUpUser(name: string): Promise<{ email: string; cookie: string; userId: string }> {
  const email = uniqueEmail(name);
  const res = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name, email, password: "ValidPass1" })
    .expect(200);
  const cookie = sessionCookie(res);
  if (!cookie) {
    throw new Error("Expected a session cookie after sign up");
  }
  return { email, cookie, userId: res.body.user.id as string };
}

// ---------------------------------------------------------------------------
// POS product selection
// ---------------------------------------------------------------------------
describe("pos: product selection", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];
  const locationIds: string[] = [];
  const batchIds: string[] = [];

  let mainLocationId: string;
  let secondLocationId: string;
  let paracetamolId: string;
  let tabletUnitId: string;

  async function makeUnit(name: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: `${name} ${Date.now()}` })
      .expect(201);
    unitIds.push(res.body.data.id as string);
    return res.body.data.id as string;
  }

  async function makeProduct(
    name: string,
    opts: {
      sku: string;
      groupId: string;
      units?: Array<{ unitId: string; conversionFactor: number; sellPrice?: number; isBaseUnit?: boolean }>;
      isActive?: boolean;
      minimumStock?: number;
    },
  ): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name,
        sku: opts.sku,
        productGroupId: opts.groupId,
        isActive: opts.isActive,
        minimumStock: opts.minimumStock,
        units: opts.units,
      })
      .expect(201);
    productIds.push(res.body.data.id as string);
    return res.body.data.id as string;
  }

  async function seedStock(productId: string, batchNumber: string, quantity: number): Promise<string> {
    const batch = await prisma.batch.create({
      data: {
        productId,
        batchNumber,
        expiryDate: new Date("2032-06-30T00:00:00.000Z"),
      },
    });
    batchIds.push(batch.id);
    await stockMovementService.recordMovement({
      productId,
      batchId: batch.id,
      locationId: mainLocationId,
      transactionType: "OPENING",
      direction: "IN",
      quantity,
      actor: { id: userIds[0] },
    });
    return batch.id;
  }

  beforeAll(async () => {
    const admin = await signUpUser("pos-list");
    cookie = admin.cookie;
    userIds.push(admin.userId);

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Pos Analgesics ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);
    const groupId = group.body.data.id as string;

    const secondGroup = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Pos Second ${Date.now()}` })
      .expect(201);
    groupIds.push(secondGroup.body.data.id as string);
    const secondGroupId = secondGroup.body.data.id as string;

    const main = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: `Pos Main ${Date.now()}` })
      .expect(201);
    mainLocationId = main.body.data.id as string;
    locationIds.push(mainLocationId);

    const second = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: `Pos Second Store ${Date.now()}` })
      .expect(201);
    secondLocationId = second.body.data.id as string;
    locationIds.push(secondLocationId);

    tabletUnitId = await makeUnit("Tablet");
    const boxUnitId = await makeUnit("Box");

    // Sellable: active, with priced units.
    paracetamolId = await makeProduct("Pos Paracetamol 500mg", {
      sku: `POS-PCM-${Date.now()}`,
      groupId,
      units: [
        { unitId: tabletUnitId, conversionFactor: 1, sellPrice: 2, isBaseUnit: true },
        { unitId: boxUnitId, conversionFactor: 100, sellPrice: 160 },
      ],
    });

    // Sellable, different brand/group (for filters), low-stock threshold.
    await makeProduct("Pos Ibuprofen 400mg", {
      sku: `POS-IBU-${Date.now()}`,
      groupId: secondGroupId,
      brand: "Brufen",
      minimumStock: 150,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 1.5, isBaseUnit: true }],
    });

    // Not sellable: inactive product.
    await makeProduct("Pos Retired Syrup", {
      sku: `POS-RET-${Date.now()}`,
      groupId,
      isActive: false,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 5, isBaseUnit: true }],
    });

    // Not sellable: active product without a priced unit.
    const freeUnitId = await makeUnit("Piece");
    await makeProduct("Pos Free Sample", {
      sku: `POS-FREE-${Date.now()}`,
      groupId,
      units: [{ unitId: freeUnitId, conversionFactor: 1, isBaseUnit: true }],
    });

    await seedStock(paracetamolId, `POS-1-${Date.now()}`, 200);
  });

  afterAll(async () => {
    await prisma.sale.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.stockTransaction.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.inventoryStock.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.batch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/v1/pos/products").expect(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns only active products with a configured selling unit", async () => {
    const res = await request(app)
      .get("/api/v1/pos/products?limit=50")
      .set("Cookie", cookie)
      .expect(200);
    const names = res.body.data.map((p: { name: string }) => p.name);
    expect(names).toContain("Pos Paracetamol 500mg");
    expect(names).toContain("Pos Ibuprofen 400mg");
    expect(names).not.toContain("Pos Retired Syrup");
    expect(names).not.toContain("Pos Free Sample");
  });

  it("exposes unit-specific prices and available stock in base units", async () => {
    const res = await request(app)
      .get("/api/v1/pos/products?search=paracetamol")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.meta.total).toBe(1);
    const product = res.body.data[0];
    expect(product.availableStock).toBe(200);
    expect(product.stockStatus).toBe("IN_STOCK");
    const units = product.units.map((u: { unitName: string; sellPrice: number | null }) => ({
      name: u.unitName,
      price: u.sellPrice,
    }));
    expect(units).toEqual(
      expect.arrayContaining([
        { name: "Tablet", price: 2 },
        { name: "Box", price: 160 },
      ]),
    );
  });

  it("filters by brand and product group", async () => {
    const byBrand = await request(app)
      .get("/api/v1/pos/products?brand=brufen")
      .set("Cookie", cookie)
      .expect(200);
    expect(byBrand.body.data.map((p: { name: string }) => p.name)).toEqual(["Pos Ibuprofen 400mg"]);

    const byGroup = await request(app)
      .get(`/api/v1/pos/products?search=ibuprofen`)
      .set("Cookie", cookie)
      .expect(200);
    expect(byGroup.body.data.length).toBe(1);
  });

  it("reports stock status from available stock vs threshold", async () => {
    const res = await request(app)
      .get("/api/v1/pos/products?search=ibuprofen")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data[0].stockStatus).toBe("OUT_OF_STOCK"); // no stock seeded
  });

  it("narrows stock to the selected location", async () => {
    const res = await request(app)
      .get(`/api/v1/pos/products?search=paracetamol&locationId=${secondLocationId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data[0].availableStock).toBe(0);
    expect(res.body.data[0].stockStatus).toBe("OUT_OF_STOCK");
  });

  it("allows a cashier role to browse POS products", async () => {
    const cashier = await signUpUser("pos-cashier");
    await prisma.user.update({
      where: { id: cashier.userId },
      data: { role: UserRole.CASHIER },
    });
    userIds.push(cashier.userId);
    const res = await request(app)
      .get("/api/v1/pos/products")
      .set("Cookie", cashier.cookie)
      .expect(200);
    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POS sales
// ---------------------------------------------------------------------------
describe("pos: sales", () => {
  let cookie: string;
  let actorId: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];
  const locationIds: string[] = [];
  const batchIds: string[] = [];

  let mainLocationId: string;
  let inactiveLocationId: string;
  let paracetamolId: string;
  let expiredOnlyProductId: string;
  let retiredProductId: string;
  let tabletUnitId: string;
  let stripUnitId: string;
  let boxUnitId: string;
  let bottleUnitId: string;
  let noPriceUnitId: string;

  async function makeUnit(name: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: `${name} ${Date.now()}` })
      .expect(201);
    unitIds.push(res.body.data.id as string);
    return res.body.data.id as string;
  }

  async function makeProduct(
    name: string,
    opts: {
      sku: string;
      groupId: string;
      units?: Array<{ unitId: string; conversionFactor: number; sellPrice?: number; isBaseUnit?: boolean }>;
      isActive?: boolean;
    },
  ): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name,
        sku: opts.sku,
        productGroupId: opts.groupId,
        isActive: opts.isActive,
        units: opts.units,
      })
      .expect(201);
    productIds.push(res.body.data.id as string);
    return res.body.data.id as string;
  }

  /**
   * Creates a batch and opens stock at the main location directly through the
   * movement service (bypassing HTTP for speed/independence).
   */
  async function seedStock(
    productId: string,
    batchNumber: string,
    quantity: number,
    expiryDate = "2032-06-30T00:00:00.000Z",
    reserved = 0,
  ): Promise<string> {
    const batch = await prisma.batch.create({
      data: { productId, batchNumber, expiryDate: new Date(expiryDate) },
    });
    batchIds.push(batch.id);
    await stockMovementService.recordMovement({
      productId,
      batchId: batch.id,
      locationId: mainLocationId,
      transactionType: "OPENING",
      direction: "IN",
      quantity,
      actor: { id: actorId },
    });
    if (reserved > 0) {
      await prisma.inventoryStock.update({
        where: { batchId_locationId: { batchId: batch.id, locationId: mainLocationId } },
        data: { reservedQuantity: reserved },
      });
    }
    return batch.id;
  }

  async function stockOf(batchId: string): Promise<number> {
    const stock = await prisma.inventoryStock.findUnique({
      where: {
        batchId_locationId: { batchId, locationId: mainLocationId },
      },
    });
    return stock?.quantity.toNumber() ?? 0;
  }

  function sell(body: Record<string, unknown>) {
    return request(app).post("/api/v1/pos/sales").set("Cookie", cookie).send(body);
  }

  beforeAll(async () => {
    const admin = await signUpUser("pos-sales");
    cookie = admin.cookie;
    actorId = admin.userId;
    userIds.push(actorId);

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Pos Sales Group ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);
    const groupId = group.body.data.id as string;

    const main = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: `Pos Sales Main ${Date.now()}` })
      .expect(201);
    mainLocationId = main.body.data.id as string;
    locationIds.push(mainLocationId);

    const retired = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: `Pos Sales Retired ${Date.now()}` })
      .expect(201);
    inactiveLocationId = retired.body.data.id as string;
    locationIds.push(inactiveLocationId);
    await request(app)
      .patch(`/api/v1/inventory/locations/${inactiveLocationId}`)
      .set("Cookie", cookie)
      .send({ isActive: false })
      .expect(200);

    // Paracetamol: Tablet (base, 2), Strip (x10, 18), Box (x100, 160),
    // Sachet (x5, no price — never sellable).
    tabletUnitId = await makeUnit("Tablet");
    stripUnitId = await makeUnit("Strip");
    boxUnitId = await makeUnit("Box");
    bottleUnitId = await makeUnit("Bottle");
    noPriceUnitId = await makeUnit("Sachet");

    paracetamolId = await makeProduct("Pos Sales Paracetamol", {
      sku: `POS-S-PCM-${Date.now()}`,
      groupId,
      units: [
        { unitId: tabletUnitId, conversionFactor: 1, sellPrice: 2, isBaseUnit: true },
        { unitId: stripUnitId, conversionFactor: 10, sellPrice: 18 },
        { unitId: boxUnitId, conversionFactor: 100, sellPrice: 160 },
        { unitId: noPriceUnitId, conversionFactor: 5 },
      ],
    });

    // Ibuprofen: only Tablet base + Bottle (Bottle is NOT configured for Paracetamol).
    await makeProduct("Pos Sales Ibuprofen", {
      sku: `POS-S-IBU-${Date.now()}`,
      groupId,
      units: [
        { unitId: tabletUnitId, conversionFactor: 1, sellPrice: 1.5, isBaseUnit: true },
        { unitId: bottleUnitId, conversionFactor: 50, sellPrice: 60 },
      ],
    });

    // Inactive product with priced units.
    retiredProductId = await makeProduct("Pos Sales Retired", {
      sku: `POS-S-RET-${Date.now()}`,
      groupId,
      isActive: false,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 9, isBaseUnit: true }],
    });

    // Product whose only stock is on a batch that we will expire.
    expiredOnlyProductId = await makeProduct("Pos Sales Syrup", {
      sku: `POS-S-SYR-${Date.now()}`,
      groupId,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 30, isBaseUnit: true }],
    });
  });

  afterAll(async () => {
    await prisma.sale.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.stockTransaction.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.inventoryStock.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.batch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  // ------------------------------------------------------------------
  // Product / unit validation
  // ------------------------------------------------------------------

  it("rejects an unknown product", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: "00000000-0000-4000-8000-000000000000", unitId: tabletUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(404);
    expect(res.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("rejects an inactive product", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: retiredProductId, unitId: tabletUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(409);
    expect(res.body.error.code).toBe("PRODUCT_INACTIVE");
  });

  it("rejects a unit not configured for the product", async () => {
    // Bottle is configured for Ibuprofen only — selling Paracetamol in Bottles is invalid.
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: bottleUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(422);
    expect(res.body.error.code).toBe("INVALID_UNIT");
  });

  it("rejects a unit without a configured selling price", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: noPriceUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(422);
    expect(res.body.error.code).toBe("UNIT_NO_SELL_PRICE");
  });

  it("rejects an inactive location", async () => {
    const res = await sell({
      locationId: inactiveLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(409);
    expect(res.body.error.code).toBe("INACTIVE_LOCATION");
  });

  it("rejects zero or negative quantities", async () => {
    const zero = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 0 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(422);
    expect(zero.body.error.code).toBe("VALIDATION_ERROR");

    const negative = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: -5 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(422);
    expect(negative.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ------------------------------------------------------------------
  // Multi-unit sales + conversion
  // ------------------------------------------------------------------

  it("normalizes entered quantity to the base unit (2 Boxes = 200 Tablets)", async () => {
    const batchId = await seedStock(paracetamolId, `MULTI-${Date.now()}`, 300);
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: boxUnitId, quantity: 2 }],
      payments: [{ method: "CASH", amount: 320 }],
    }).expect(201);

    const item = res.body.data.items[0];
    expect(item.quantity).toBe(2);
    expect(item.unitId).toBe(boxUnitId);
    expect(item.baseQuantity).toBe(200);
    expect(item.conversionFactor).toBe(100);
    expect(item.lineTotal).toBe(320);
    expect(await stockOf(batchId)).toBe(100); // 300 - 200 base units
  });

  it("supports several units in one sale with unit-specific prices", async () => {
    const batchId = await seedStock(paracetamolId, `UNITS-${Date.now()}`, 1000);
    const res = await sell({
      locationId: mainLocationId,
      items: [
        { productId: paracetamolId, unitId: boxUnitId, quantity: 2 }, // 200 base, 320
        { productId: paracetamolId, unitId: stripUnitId, quantity: 1 }, // 10 base, 18
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 5 }, // 5 base, 10
      ],
      payments: [{ method: "CASH", amount: 348 }],
    }).expect(201);

    expect(res.body.data.subtotal).toBe(348);
    expect(res.body.data.totalAmount).toBe(348);
    expect(res.body.data.items).toHaveLength(3);
    const quantities = res.body.data.items.map((i: { baseQuantity: number }) => i.baseQuantity);
    expect(quantities).toEqual(expect.arrayContaining([200, 10, 5]));
    expect(await stockOf(batchId)).toBe(785); // 1000 - 215 base units
  });

  // ------------------------------------------------------------------
  // Pricing
  // ------------------------------------------------------------------

  it("uses unit-specific prices (Box 160, not base price x factor)", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: boxUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 160 }],
    }).expect(201);
    expect(res.body.data.subtotal).toBe(160);
  });

  it("applies a price override without changing ProductUnit.sellPrice", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [
        {
          productId: paracetamolId,
          unitId: boxUnitId,
          quantity: 2,
          actualUnitPrice: 150,
        },
      ],
      payments: [{ method: "CASH", amount: 300 }],
    }).expect(201);

    const item = res.body.data.items[0];
    expect(item.originalUnitPrice).toBe(160);
    expect(item.actualUnitPrice).toBe(150);
    expect(item.lineTotal).toBe(300);

    const config = await prisma.productUnit.findFirst({
      where: { productId: paracetamolId, unitId: boxUnitId },
    });
    expect(config?.sellPrice?.toNumber()).toBe(160);
  });

  it("preserves the sale-time price after ProductUnit.sellPrice changes", async () => {
    const saleRes = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10 }],
      payments: [{ method: "CASH", amount: 20 }],
    }).expect(201);
    const saleId = saleRes.body.data.id as string;

    await prisma.productUnit.updateMany({
      where: { productId: paracetamolId, unitId: tabletUnitId },
      data: { sellPrice: 9.99 },
    });

    const fetched = await request(app)
      .get(`/api/v1/pos/sales/${saleId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(fetched.body.data.items[0].originalUnitPrice).toBe(2);
    expect(fetched.body.data.items[0].actualUnitPrice).toBe(2);
    expect(fetched.body.data.subtotal).toBe(20);
  });

  // ------------------------------------------------------------------
  // Discounts
  // ------------------------------------------------------------------

  it("applies an item percentage discount", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [
        {
          productId: paracetamolId,
          unitId: boxUnitId,
          quantity: 2, // 320
          discount: { type: "PERCENTAGE", value: 10 },
        },
      ],
      payments: [{ method: "CASH", amount: 288 }],
    }).expect(201);
    const item = res.body.data.items[0];
    expect(item.discountAmount).toBe(32);
    expect(item.lineTotal).toBe(288);
    expect(res.body.data.totalDiscount).toBe(32);
    expect(res.body.data.totalAmount).toBe(288);
  });

  it("applies an item fixed discount", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [
        {
          productId: paracetamolId,
          unitId: boxUnitId,
          quantity: 2, // 320
          discount: { type: "FIXED_AMOUNT", value: 50 },
        },
      ],
      payments: [{ method: "CASH", amount: 270 }],
    }).expect(201);
    expect(res.body.data.items[0].lineTotal).toBe(270);
    expect(res.body.data.totalAmount).toBe(270);
  });

  it("caps a fixed discount at the line total (never negative)", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [
        {
          productId: paracetamolId,
          unitId: tabletUnitId,
          quantity: 1, // 2
          discount: { type: "FIXED_AMOUNT", value: 500 },
        },
      ],
      payments: [{ method: "CASH", amount: 0 }],
    }).expect(201);
    expect(res.body.data.items[0].discountAmount).toBe(2);
    expect(res.body.data.items[0].lineTotal).toBe(0);
    expect(res.body.data.totalAmount).toBe(0);
  });

  it("applies a bill percentage discount", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [
        { productId: paracetamolId, unitId: boxUnitId, quantity: 1 }, // 160
        { productId: paracetamolId, unitId: stripUnitId, quantity: 1 }, // 18
      ],
      billDiscount: { type: "PERCENTAGE", value: 10 }, // 178 - 17.8 = 160.2
      payments: [{ method: "CASH", amount: 160.2 }],
    }).expect(201);
    expect(res.body.data.subtotal).toBe(178);
    expect(res.body.data.totalDiscount).toBe(17.8);
    expect(res.body.data.totalAmount).toBe(160.2);
  });

  it("applies a bill fixed discount", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: boxUnitId, quantity: 1 }], // 160
      billDiscount: { type: "FIXED_AMOUNT", value: 30 },
      payments: [{ method: "CASH", amount: 130 }],
    }).expect(201);
    expect(res.body.data.totalAmount).toBe(130);
    expect(res.body.data.billDiscountValue).toBe(30);
  });

  it("rejects an invalid percentage discount", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [
        {
          productId: paracetamolId,
          unitId: tabletUnitId,
          quantity: 1,
          discount: { type: "PERCENTAGE", value: 150 },
        },
      ],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ------------------------------------------------------------------
  // Batches: expiry, FEFO, multi-batch, insufficient, reserved
  // ------------------------------------------------------------------

  it("never sells from an expired batch", async () => {
    const batchId = await seedStock(expiredOnlyProductId, `EXP-${Date.now()}`, 100);
    await prisma.batch.update({
      where: { id: batchId },
      data: { expiryDate: new Date("2020-01-01T00:00:00.000Z") },
    });

    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: expiredOnlyProductId, unitId: tabletUnitId, quantity: 10 }],
      payments: [{ method: "CASH", amount: 300 }],
    }).expect(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await stockOf(batchId)).toBe(100);
  });

  it("allocates across batches with FEFO (earliest expiry first)", async () => {
    const lateBatch = await seedStock(
      paracetamolId,
      `FEFO-LATE-${Date.now()}`,
      100,
      "2033-01-15T00:00:00.000Z",
    );
    const earlyBatch = await seedStock(
      paracetamolId,
      `FEFO-EARLY-${Date.now()}`,
      100,
      "2031-01-15T00:00:00.000Z",
    );

    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 120 }],
      payments: [{ method: "CASH", amount: 240 }],
    }).expect(201);

    const allocations = res.body.data.items[0].batchAllocations as Array<{
      batchId: string;
      baseQuantity: number;
    }>;
    expect(allocations).toHaveLength(2);
    // Earliest expiry consumed first, fully.
    expect(allocations[0].batchId).toBe(earlyBatch);
    expect(allocations[0].baseQuantity).toBe(100);
    expect(allocations[1].batchId).toBe(lateBatch);
    expect(allocations[1].baseQuantity).toBe(20);

    expect(await stockOf(earlyBatch)).toBe(0);
    expect(await stockOf(lateBatch)).toBe(80);
  });

  it("rejects insufficient stock and creates no records", async () => {
    await seedStock(paracetamolId, `INSUF-${Date.now()}`, 100);
    const salesBefore = await prisma.sale.count();

    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 150 }],
      payments: [{ method: "CASH", amount: 300 }],
    }).expect(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await prisma.sale.count()).toBe(salesBefore);
  });

  it("considers reservedQuantity when validating availability", async () => {
    const batchId = await seedStock(paracetamolId, `RES-${Date.now()}`, 100, "2032-06-30T00:00:00.000Z", 40);
    const salesBefore = await prisma.sale.count();

    // Available = 60 (100 - 40 reserved) — selling 70 must fail and roll back.
    const fail = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 70 }],
      payments: [{ method: "CASH", amount: 140 }],
    }).expect(409);
    expect(fail.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await prisma.sale.count()).toBe(salesBefore);
    expect(await stockOf(batchId)).toBe(100);

    // Selling within the available amount succeeds.
    const ok = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 50 }],
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(201);
    expect(ok.body.data.items[0].baseQuantity).toBe(50);
    expect(await stockOf(batchId)).toBe(50);
  });

  // ------------------------------------------------------------------
  // Payments
  // ------------------------------------------------------------------

  it("accepts a single cash payment", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10 }],
      payments: [{ method: "CASH", amount: 20 }],
    }).expect(201);
    expect(res.body.data.paidAmount).toBe(20);
    expect(res.body.data.changeAmount).toBe(0);
    expect(res.body.data.payments[0].method).toBe("CASH");
  });

  it("supports split payments", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: boxUnitId, quantity: 1 }], // 160
      payments: [
        { method: "CASH", amount: 60 },
        { method: "DIGITAL_TRANSFER", amount: 100 },
      ],
    }).expect(201);
    expect(res.body.data.paidAmount).toBe(160);
    expect(res.body.data.payments.map((p: { method: string }) => p.method).sort()).toEqual(
      ["CASH", "DIGITAL_TRANSFER"],
    );
    expect(res.body.data.changeAmount).toBe(0);
  });

  it("rejects insufficient payments", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: boxUnitId, quantity: 1 }], // 160
      payments: [{ method: "CASH", amount: 100 }],
    }).expect(422);
    expect(res.body.error.code).toBe("INSUFFICIENT_PAYMENT");
  });

  it("records cash overpayment as change", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: boxUnitId, quantity: 1 }], // 160
      payments: [{ method: "CASH", amount: 500 }],
    }).expect(201);
    expect(res.body.data.paidAmount).toBe(500);
    expect(res.body.data.changeAmount).toBe(340);
  });

  // ------------------------------------------------------------------
  // Sale transaction integrity
  // ------------------------------------------------------------------

  it("creates the sale, items, allocations, payments and SALE stock transactions", async () => {
    const batchId = await seedStock(paracetamolId, `FULL-${Date.now()}`, 100);
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 40 }],
      payments: [{ method: "CASH", amount: 80 }],
    }).expect(201);

    const data = res.body.data;
    expect(data.status).toBe("COMPLETED");
    expect(data.saleNumber).toMatch(/^SL-\d{8}-[0-9A-F]{6}$/);
    expect(data.items[0].baseQuantity).toBe(40);
    expect(data.items[0].batchAllocations[0].batchId).toBe(batchId);
    expect(data.payments[0].amount).toBe(80);

    const transactions = await prisma.stockTransaction.findMany({
      where: { referenceType: "Sale", referenceId: data.id },
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].transactionType).toBe("SALE");
    expect(transactions[0].direction).toBe("OUT");
    expect(transactions[0].quantity.toNumber()).toBe(40);
    expect(transactions[0].balanceAfter.toNumber()).toBe(60);
    expect(transactions[0].batchId).toBe(batchId);
    expect(await stockOf(batchId)).toBe(60);
  });

  it("rolls back everything when one line has insufficient stock", async () => {
    const goodBatch = await seedStock(paracetamolId, `RB-GOOD-${Date.now()}`, 100);
    await seedStock(paracetamolId, `RB-BAD-${Date.now()}`, 10);
    const salesBefore = await prisma.sale.count();
    const txBefore = await prisma.stockTransaction.count();

    const res = await sell({
      locationId: mainLocationId,
      items: [
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 50 }, // ok
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 999 }, // impossible
      ],
      payments: [{ method: "CASH", amount: 1000 }],
    }).expect(409);

    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await prisma.sale.count()).toBe(salesBefore);
    expect(await prisma.stockTransaction.count()).toBe(txBefore);
    expect(await stockOf(goodBatch)).toBe(100);
  });

  it("rolls back when sale creation fails (invalid cashier)", async () => {
    const batchId = await seedStock(paracetamolId, `RB-FK-${Date.now()}`, 100);
    const salesBefore = await prisma.sale.count();

    await expect(
      saleService.complete(
        {
          locationId: mainLocationId,
          items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10 }],
          payments: [{ method: "CASH", amount: 20 }],
        },
        { id: "00000000-0000-4000-8000-000000000000" },
      ),
    ).rejects.toBeTruthy();

    expect(await prisma.sale.count()).toBe(salesBefore);
    expect(await stockOf(batchId)).toBe(100);
  });

  it("prevents overselling under concurrent requests", async () => {
    const batchId = await seedStock(paracetamolId, `CONC-${Date.now()}`, 100);
    const body = {
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 60 }],
      payments: [{ method: "CASH", amount: 120 }],
    };

    const [first, second] = await Promise.all([
      sell(body),
      sell(body),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 409]);
    expect(await stockOf(batchId)).toBe(40);
    const completed = await prisma.sale.count({ where: { status: "COMPLETED" } });
    expect(completed).toBeGreaterThan(0);
  });

  it("rejects cancellation of a completed sale", async () => {
    const res = await sell({
      locationId: mainLocationId,
      items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 1 }],
      payments: [{ method: "CASH", amount: 2 }],
    }).expect(201);
    const saleId = res.body.data.id as string;

    const cancel = await request(app)
      .post(`/api/v1/pos/sales/${saleId}/cancel`)
      .set("Cookie", cookie)
      .send({ reason: "Oops" })
      .expect(409);
    expect(cancel.body.error.code).toBe("SALE_NOT_CANCELLABLE");
  });

  it("lists sales and filters by status", async () => {
    const list = await request(app)
      .get("/api/v1/pos/sales?status=COMPLETED&limit=100")
      .set("Cookie", cookie)
      .expect(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(list.body.data.every((s: { status: string }) => s.status === "COMPLETED")).toBe(true);
  });

  it("allows a cashier role to complete a sale", async () => {
    const cashier = await signUpUser("pos-sales-cashier");
    await prisma.user.update({
      where: { id: cashier.userId },
      data: { role: UserRole.CASHIER },
    });
    userIds.push(cashier.userId);

    await seedStock(paracetamolId, `CASHIER-${Date.now()}`, 100);
    const res = await request(app)
      .post("/api/v1/pos/sales")
      .set("Cookie", cashier.cookie)
      .send({
        locationId: mainLocationId,
        items: [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 1 }],
        payments: [{ method: "CASH", amount: 2 }],
      })
      .expect(201);
    expect(res.body.data.cashier.id).toBe(cashier.userId);
  });
});