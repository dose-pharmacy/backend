import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

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

const FUTURE_EXPIRY = "2032-06-30";

describe("inventory: master units", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];

  function uniqueName(base: string): string {
    return `${base} ${Date.now()}.${Math.random().toString(16).slice(2)}`;
  }

  async function makeGroup(name: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name })
      .expect(201);
    groupIds.push(res.body.data.id as string);
    return res.body.data.id as string;
  }

  async function makeProduct(name: string, skuSuffix: string, groupId: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name, sku: `${skuSuffix}-${Date.now()}`, productGroupId: groupId })
      .expect(201);
    productIds.push(res.body.data.id as string);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    const admin = await signUpUser("units-master");
    cookie = admin.cookie;
    userIds.push(admin.userId);
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("creates a reusable master unit", async () => {
    const tabletName = uniqueName("Tablet");
    const res = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: tabletName, symbol: "TAB", description: "Single tablet" })
      .expect(201);
    expect(res.body.data.name).toBe(tabletName);
    expect(res.body.data.symbol).toBe("TAB");
    expect(res.body.data.isActive).toBe(true);
    unitIds.push(res.body.data.id as string);
  });

  it("rejects duplicate master unit names (case-insensitive)", async () => {
    const stripName = uniqueName("Strip");
    await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: stripName })
      .expect(201)
      .then((res) => unitIds.push(res.body.data.id as string));

    const res = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: stripName.toLowerCase() })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_UNIT");
  });

  it("lists, searches and filters units", async () => {
    const boxName = uniqueName("Box");
    await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: boxName, symbol: "BX" })
      .expect(201)
      .then((res) => unitIds.push(res.body.data.id as string));

    const search = await request(app)
      .get(`/api/v1/inventory/units?search=${tabletName.split(" ")[0]}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(search.body.data.map((u: { name: string }) => u.name)).toContain(tabletName);

    const all = await request(app)
      .get("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .expect(200);
    // The units created so far in this suite are present. (Vial is created
    // by the later soft-delete test, so it is not asserted here.)
    expect(all.body.meta.total).toBeGreaterThanOrEqual(3);
    expect(all.body.data.map((u: { name: string }) => u.name)).toEqual(
      expect.arrayContaining([tabletName, stripName, boxName]),
    );
  });

  it("soft-deletes a unit by deactivating it", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: "Vial" })
      .expect(201);
    const vialId = res.body.data.id as string;
    unitIds.push(vialId);

    await request(app)
      .delete(`/api/v1/inventory/units/${vialId}`)
      .set("Cookie", cookie)
      .expect(200);

    const fetched = await request(app)
      .get(`/api/v1/inventory/units/${vialId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(fetched.body.data.isActive).toBe(false);
  });

  it("rejects configuring a deactivated unit for a product", async () => {
    const groupId = await makeGroup("Units Group");
    const productId = await makeProduct("Unitless Product", "UNITLESS", groupId);
    const vialId = unitIds[unitIds.length - 1];

    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ unitId: vialId, conversionFactor: 1, isBaseUnit: true })
      .expect(409);
    expect(res.body.error.code).toBe("UNIT_INACTIVE");
  });

  it("lets the same master unit be configured for multiple products", async () => {
    const groupId = await makeGroup("Shared Units Group");
    const firstId = await makeProduct("Shared First", "SHARE1", groupId);
    const secondId = await makeProduct("Shared Second", "SHARE2", groupId);

    const first = await request(app)
      .post(`/api/v1/inventory/products/${firstId}/units`)
      .set("Cookie", cookie)
      .send({ unitId: unitIds[0], conversionFactor: 1, isBaseUnit: true })
      .expect(201);
    expect(first.body.data.unit.name).toBe(tabletName);

    const second = await request(app)
      .post(`/api/v1/inventory/products/${secondId}/units`)
      .set("Cookie", cookie)
      .send({ unitId: unitIds[0], conversionFactor: 1, isBaseUnit: true })
      .expect(201);
    expect(second.body.data.unit.name).toBe(tabletName);
    expect(second.body.data.unitId).toBe(first.body.data.unitId);
  });
});

describe("inventory: product creation with embedded units", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];

  let tabletId: string;
  let stripId: string;
  let boxId: string;
  let groupId: string;

  function uniqueName(base: string): string {
    return `${base} ${Date.now()}.${Math.random().toString(16).slice(2)}`;
  }

  beforeAll(async () => {
    const admin = await signUpUser("units-product-create");
    cookie = admin.cookie;
    userIds.push(admin.userId);

    for (const name of ["Tablet", "Strip", "Box"]) {
      const res = await request(app)
        .post("/api/v1/inventory/units")
        .set("Cookie", cookie)
        .send({ name: uniqueName(name) })
        .expect(201);
      unitIds.push(res.body.data.id as string);
    }
    tabletId = unitIds[0];
    stripId = unitIds[1];
    boxId = unitIds[2];

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Embedded Units Group ${Date.now()}` })
      .expect(201);
    groupId = group.body.data.id as string;
    groupIds.push(groupId);
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("creates a product with multiple units atomically", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Paracetamol 500mg",
        genericName: "Paracetamol",
        brand: "Example",
        sku: `PCM-EMBED-${Date.now()}`,
        productGroupId: groupId,
        units: [
          { unitId: tabletId, conversionFactor: 1, sellPrice: 2, purchasePrice: 1.2, isBaseUnit: true },
          { unitId: stripId, conversionFactor: 10, sellPrice: 18, purchasePrice: 12, isBaseUnit: false },
          { unitId: boxId, conversionFactor: 100, sellPrice: 150, purchasePrice: 110, isBaseUnit: false },
        ],
      })
      .expect(201);

    const product = res.body.data;
    productIds.push(product.id as string);
    expect(product.units.length).toBe(3);
    expect(product.units.map((u: { unit: { name: string } }) => u.unit.name)).toEqual(
      expect.arrayContaining([
        product.units.find((u: { unit: { name: string } }) => u.unitId === tabletId)?.unit.name,
        product.units.find((u: { unit: { name: string } }) => u.unitId === stripId)?.unit.name,
        product.units.find((u: { unit: { name: string } }) => u.unitId === boxId)?.unit.name,
      ].filter(Boolean)),
    );
    const base = product.units.find((u: { isBaseUnit: boolean }) => u.isBaseUnit);
    expect(base?.unitId).toBe(tabletId);
    expect(base?.conversionFactor).toBe(1);
  });

  it("rejects a product without a base unit and creates nothing", async () => {
    const before = await prisma.product.count();
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "No Base",
        sku: `NOBASE-${Date.now()}`,
        productGroupId: groupId,
        units: [{ unitId: stripId, conversionFactor: 10 }],
      })
      .expect(409);
    expect(res.body.error.code).toBe("BASE_UNIT_REQUIRED");
    const after = await prisma.product.count();
    expect(after).toBe(before);
  });

  it("rejects multiple base units", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Two Bases",
        sku: `TWOBASE-${Date.now()}`,
        productGroupId: groupId,
        units: [
          { unitId: tabletId, conversionFactor: 1, isBaseUnit: true },
          { unitId: stripId, conversionFactor: 1, isBaseUnit: true },
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe("BASE_UNIT_EXISTS");
  });

  it("rejects a base unit whose conversion factor is not 1", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Bad Base",
        sku: `BADBASE-${Date.now()}`,
        productGroupId: groupId,
        units: [{ unitId: tabletId, conversionFactor: 2, isBaseUnit: true }],
      })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects duplicate units in the configuration", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Dup Units",
        sku: `DUPUNITS-${Date.now()}`,
        productGroupId: groupId,
        units: [
          { unitId: tabletId, conversionFactor: 1, isBaseUnit: true },
          { unitId: tabletId, conversionFactor: 2 },
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_UNIT");
  });

  it("rejects an inactive unit and rolls back the whole product creation", async () => {
    const ghostName = uniqueName("Ghost Unit");
    const inactive = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: ghostName })
      .expect(201);
    const inactiveId = inactive.body.data.id as string;
    unitIds.push(inactiveId);
    await request(app)
      .delete(`/api/v1/inventory/units/${inactiveId}`)
      .set("Cookie", cookie)
      .expect(200);

    const before = await prisma.product.count();
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Ghost Product",
        sku: `GHOST-${Date.now()}`,
        productGroupId: groupId,
        units: [
          { unitId: tabletId, conversionFactor: 1, isBaseUnit: true },
          { unitId: inactiveId, conversionFactor: 10 },
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe("UNIT_INACTIVE");
    const after = await prisma.product.count();
    expect(after).toBe(before);
  });

  it("rejects a non-existent unit id", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Orphan Unit",
        sku: `ORPHANUNIT-${Date.now()}`,
        productGroupId: groupId,
        units: [{ unitId: "00000000-0000-4000-8000-000000000000", conversionFactor: 1, isBaseUnit: true }],
      })
      .expect(404);
    expect(res.body.error.code).toBe("UNIT_NOT_FOUND");
  });
});

describe("inventory: conversion", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];

  let tabletId: string;
  let stripId: string;
  let boxId: string;
  let productId: string;

  function uniqueName(base: string): string {
    return `${base} ${Date.now()}.${Math.random().toString(16).slice(2)}`;
  }

  beforeAll(async () => {
    const admin = await signUpUser("units-conversion");
    cookie = admin.cookie;
    userIds.push(admin.userId);

    for (const name of ["Tablet", "Strip", "Box"]) {
      const res = await request(app)
        .post("/api/v1/inventory/units")
        .set("Cookie", cookie)
        .send({ name: uniqueName(name) })
        .expect(201);
      unitIds.push(res.body.data.id as string);
    }
    tabletId = unitIds[0];
    stripId = unitIds[1];
    boxId = unitIds[2];

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Conversion Group ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Convertible",
        sku: `CONV-${Date.now()}`,
        productGroupId: group.body.data.id,
        units: [
          { unitId: tabletId, conversionFactor: 1, isBaseUnit: true },
          { unitId: stripId, conversionFactor: 10 },
          { unitId: boxId, conversionFactor: 100 },
        ],
      })
      .expect(201);
    productId = product.body.data.id as string;
    productIds.push(productId);
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("converts 1 Box to 100 Tablets", async () => {
    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units/convert`)
      .set("Cookie", cookie)
      .send({ quantity: 1, fromUnitId: boxId, toUnitId: tabletId })
      .expect(200);
    expect(res.body.data.convertedQuantity).toBe(100);
  });

  it("converts 5 Boxes to 500 Tablets", async () => {
    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units/convert`)
      .set("Cookie", cookie)
      .send({ quantity: 5, fromUnitId: boxId, toUnitId: tabletId })
      .expect(200);
    expect(res.body.data.convertedQuantity).toBe(500);
  });

  it("converts 2 Boxes to 20 Strips", async () => {
    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units/convert`)
      .set("Cookie", cookie)
      .send({ quantity: 2, fromUnitId: boxId, toUnitId: stripId })
      .expect(200);
    expect(res.body.data.convertedQuantity).toBe(20);
  });
});

describe("inventory: transfers", () => {
  let cookie: string;
  let actorId: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];
  const batchIds: string[] = [];
  const locationIds: string[] = [];

  let tabletId: string;
  let stripId: string;
  let boxId: string;
  let productId: string;
  let batchId: string;
  let locationAId: string;
  let locationBId: string;

  function uniqueName(base: string): string {
    return `${base} ${Date.now()}.${Math.random().toString(16).slice(2)}`;
  }

  async function openStock(batch: string, location: string, quantity: number, unitId: string) {
    await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({ productId, batchId: batch, locationId: location, quantity, unitId })
      .expect(201);
  }

  async function stockAt(batch: string, location: string): Promise<number> {
    const stock = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId: batch, locationId: location } },
    });
    return stock?.quantity.toNumber() ?? 0;
  }

  beforeAll(async () => {
    const admin = await signUpUser("units-transfers");
    cookie = admin.cookie;
    actorId = admin.userId;
    userIds.push(actorId);

    for (const name of ["Tablet", "Strip", "Box"]) {
      const res = await request(app)
        .post("/api/v1/inventory/units")
        .set("Cookie", cookie)
        .send({ name })
        .expect(201);
      unitIds.push(res.body.data.id as string);
    }
    tabletId = unitIds[0];
    stripId = unitIds[1];
    boxId = unitIds[2];

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Transfer Group ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Paracetamol 500mg",
        sku: `PCM-TRF-${Date.now()}`,
        productGroupId: group.body.data.id,
        units: [
          { unitId: tabletId, conversionFactor: 1, sellPrice: 2, purchasePrice: 1.2, isBaseUnit: true },
          { unitId: stripId, conversionFactor: 10, sellPrice: 18, purchasePrice: 12 },
          { unitId: boxId, conversionFactor: 100, sellPrice: 150, purchasePrice: 110 },
        ],
      })
      .expect(201);
    productId = product.body.data.id as string;
    productIds.push(productId);

    const batch = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "PCM-TRF-B1", expiryDate: FUTURE_EXPIRY })
      .expect(201);
    batchId = batch.body.data.id as string;
    batchIds.push(batchId);

    for (const name of ["Main Store", "Branch Store"]) {
      const loc = await request(app)
        .post("/api/v1/inventory/locations")
        .set("Cookie", cookie)
        .send({ name: `${name} ${Date.now()}` })
        .expect(201);
      locationIds.push(loc.body.data.id as string);
    }
    locationAId = locationIds[0];
    locationBId = locationIds[1];
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.stockTransfer.deleteMany({ where: { createdById: actorId } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("creates a draft transfer with a base-unit item", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        reason: "Stock redistribution",
        items: [{ productId, batchId, unitId: tabletId, quantity: 50 }],
      })
      .expect(201);
    expect(res.body.data.status).toBe("DRAFT");
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.items[0].quantity).toBe(50);
    expect(res.body.data.items[0].unitId).toBe(tabletId);
    expect(res.body.data.items[0].baseQuantity).toBe(50);
  });

  it("computes baseQuantity for a Box item (2 Boxes = 200 Tablets)", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: boxId, quantity: 2 }],
      })
      .expect(201);
    expect(res.body.data.items[0].quantity).toBe(2);
    expect(res.body.data.items[0].unitId).toBe(boxId);
    expect(res.body.data.items[0].baseQuantity).toBe(200);
  });

  it("completes a base-unit transfer and moves stock in base units", async () => {
    await openStock(batchId, locationAId, 500, tabletId);

    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: tabletId, quantity: 50 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    const res = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.status).toBe("COMPLETED");

    expect(await stockAt(batchId, locationAId)).toBe(450);
    expect(await stockAt(batchId, locationBId)).toBe(50);

    const out = await prisma.stockTransaction.findFirst({
      where: { referenceId: transferId, transactionType: "TRANSFER_OUT" },
    });
    const inTxn = await prisma.stockTransaction.findFirst({
      where: { referenceId: transferId, transactionType: "TRANSFER_IN" },
    });
    expect(out?.quantity.toNumber()).toBe(50);
    expect(inTxn?.quantity.toNumber()).toBe(50);
  });

  it("completes a Box transfer: audit keeps 2 Boxes, stock moves 200 Tablets", async () => {
    await openStock(batchId, locationAId, 1000, tabletId);

    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: boxId, quantity: 2 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;
    const itemId = create.body.data.items[0].id as string;

    const before = await stockAt(batchId, locationAId);
    const destBefore = await stockAt(batchId, locationBId);
    expect(before).toBe(1450);
    expect(destBefore).toBe(50);

    await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await stockAt(batchId, locationAId)).toBe(1250);
    expect(await stockAt(batchId, locationBId)).toBe(250);

    // Audit trail retains the user entry; the engine moved base units.
    const fetched = await request(app)
      .get(`/api/v1/inventory/transfers/${transferId}`)
      .set("Cookie", cookie)
      .expect(200);
    const item = fetched.body.data.items.find((i: { id: string }) => i.id === itemId);
    expect(item.quantity).toBe(2);
    expect(item.unitId).toBe(boxId);
    expect(item.baseQuantity).toBe(200);

    const out = await prisma.stockTransaction.findFirst({
      where: { referenceId: transferId, transactionType: "TRANSFER_OUT" },
    });
    expect(out?.quantity.toNumber()).toBe(200);
  });

  it("rejects completing a transfer with insufficient source stock", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: boxId, quantity: 999999 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    const res = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");

    const transfer = await prisma.stockTransfer.findUnique({ where: { id: transferId } });
    expect(transfer?.status).toBe("DRAFT");
  });

  it("rejects an invalid batch/product combination", async () => {
    const otherGroup = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Other Product Group ${Date.now()}` })
      .expect(201);
    groupIds.push(otherGroup.body.data.id as string);
    const otherProduct = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name: "Ibuprofen", sku: `IBU-TRF-${Date.now()}`, productGroupId: otherGroup.body.data.id })
      .expect(201);
    productIds.push(otherProduct.body.data.id as string);

    const res = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId: otherProduct.body.data.id, batchId, unitId: tabletId, quantity: 10 }],
      })
      .expect(422);
    expect(res.body.error.code).toBe("BATCH_PRODUCT_MISMATCH");
  });

  it("rejects an invalid product/unit combination", async () => {
    const foreignUnit = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: "Sachet" })
      .expect(201);
    unitIds.push(foreignUnit.body.data.id as string);

    const res = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: foreignUnit.body.data.id, quantity: 10 }],
      })
      .expect(422);
    expect(res.body.error.code).toBe("INVALID_UNIT");
  });

  it("rejects duplicate product + batch + unit items", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [
          { productId, batchId, unitId: tabletId, quantity: 10 },
          { productId, batchId, unitId: tabletId, quantity: 20 },
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_TRANSFER_ITEM");
  });

  it("adds, updates and deletes draft items", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({ fromLocationId: locationAId, toLocationId: locationBId, items: [] })
      .expect(201);
    const transferId = create.body.data.id as string;

    // Add an item
    const add = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/items`)
      .set("Cookie", cookie)
      .send({ productId, batchId, unitId: boxId, quantity: 1 })
      .expect(201);
    const itemId = add.body.data.id as string;
    expect(add.body.data.baseQuantity).toBe(100);

    // Update its quantity (2 Boxes -> 200)
    const patch = await request(app)
      .patch(`/api/v1/inventory/transfers/${transferId}/items/${itemId}`)
      .set("Cookie", cookie)
      .send({ quantity: 2 })
      .expect(200);
    expect(patch.body.data.quantity).toBe(2);
    expect(patch.body.data.baseQuantity).toBe(200);

    // Update its unit (2 Strips -> 20)
    const patchUnit = await request(app)
      .patch(`/api/v1/inventory/transfers/${transferId}/items/${itemId}`)
      .set("Cookie", cookie)
      .send({ unitId: stripId })
      .expect(200);
    expect(patchUnit.body.data.unitId).toBe(stripId);
    expect(patchUnit.body.data.baseQuantity).toBe(20);

    // Delete it
    await request(app)
      .delete(`/api/v1/inventory/transfers/${transferId}/items/${itemId}`)
      .set("Cookie", cookie)
      .expect(200);
    const fetched = await request(app)
      .get(`/api/v1/inventory/transfers/${transferId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(fetched.body.data.items).toEqual([]);
  });

  it("rejects adding a duplicate item to a draft", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: tabletId, quantity: 10 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    const res = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/items`)
      .set("Cookie", cookie)
      .send({ productId, batchId, unitId: tabletId, quantity: 20 })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_TRANSFER_ITEM");
  });

  it("does not allow the generic update to change status", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: tabletId, quantity: 10 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    const res = await request(app)
      .patch(`/api/v1/inventory/transfers/${transferId}`)
      .set("Cookie", cookie)
      .send({ status: "COMPLETED", reason: "hack" })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    const transfer = await prisma.stockTransfer.findUnique({ where: { id: transferId } });
    expect(transfer?.status).toBe("DRAFT");
  });

  it("cannot edit items after completion", async () => {
    await openStock(batchId, locationAId, 100, tabletId);
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: tabletId, quantity: 10 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(200);

    const add = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/items`)
      .set("Cookie", cookie)
      .send({ productId, batchId, unitId: tabletId, quantity: 5 })
      .expect(409);
    expect(add.body.error.code).toBe("TRANSFER_NOT_EDITABLE");

    const update = await request(app)
      .patch(`/api/v1/inventory/transfers/${transferId}`)
      .set("Cookie", cookie)
      .send({ reason: "too late" })
      .expect(409);
    expect(update.body.error.code).toBe("TRANSFER_NOT_EDITABLE");
  });

  it("cannot edit items after cancellation", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: tabletId, quantity: 10 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/cancel`)
      .set("Cookie", cookie)
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/items`)
      .set("Cookie", cookie)
      .send({ productId, batchId, unitId: tabletId, quantity: 5 })
      .expect(409);
    expect(res.body.error.code).toBe("TRANSFER_NOT_EDITABLE");

    const complete = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(409);
    expect(complete.body.error.code).toBe("CONFLICT");
  });

  it("cannot cancel a completed transfer", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [{ productId, batchId, unitId: tabletId, quantity: 1 }],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    const res = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.status).toBe("COMPLETED");

    const cancel = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/cancel`)
      .set("Cookie", cookie)
      .expect(409);
    expect(cancel.body.error.code).toBe("CONFLICT");
  });
});

describe("inventory: transfer atomicity", () => {
  let cookie: string;
  let actorId: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];
  const batchIds: string[] = [];
  const locationIds: string[] = [];

  let tabletId: string;
  let productId: string;
  let validBatchId: string;
  let expiredBatchId: string;
  let locationAId: string;
  let locationBId: string;

  beforeAll(async () => {
    const admin = await signUpUser("units-atomicity");
    cookie = admin.cookie;
    actorId = admin.userId;
    userIds.push(actorId);

    const tablet = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: "Tablet" })
      .expect(201);
    tabletId = tablet.body.data.id as string;
    unitIds.push(tabletId);

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Atomicity Group ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Atomicity Product",
        sku: `ATOM-${Date.now()}`,
        productGroupId: group.body.data.id,
        units: [{ unitId: tabletId, conversionFactor: 1, isBaseUnit: true }],
      })
      .expect(201);
    productId = product.body.data.id as string;
    productIds.push(productId);

    const valid = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "ATOM-VALID", expiryDate: FUTURE_EXPIRY })
      .expect(201);
    validBatchId = valid.body.data.id as string;
    batchIds.push(validBatchId);

    // Expired batch created directly (the API rejects receiving into it).
    const expired = await prisma.batch.create({
      data: {
        productId,
        batchNumber: `ATOM-EXPIRED-${Date.now()}`,
        expiryDate: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    expiredBatchId = expired.id;
    batchIds.push(expiredBatchId);

    for (const name of ["Atomic Source", "Atomic Dest"]) {
      const loc = await request(app)
        .post("/api/v1/inventory/locations")
        .set("Cookie", cookie)
        .send({ name: `${name} ${Date.now()}` })
        .expect(201);
      locationIds.push(loc.body.data.id as string);
    }
    locationAId = locationIds[0];
    locationBId = locationIds[1];

    // Seed stock: 500 valid tablets at source; 10 expired tablets at source.
    await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({ productId, batchId: validBatchId, locationId: locationAId, quantity: 500, unitId: tabletId })
      .expect(201);
    await prisma.inventoryStock.create({
      data: {
        productId,
        batchId: expiredBatchId,
        locationId: locationAId,
        quantity: 10,
      },
    });
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.stockTransfer.deleteMany({ where: { createdById: actorId } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("rolls back OUT + IN + status when a destination movement fails", async () => {
    const create = await request(app)
      .post("/api/v1/inventory/transfers")
      .set("Cookie", cookie)
      .send({
        fromLocationId: locationAId,
        toLocationId: locationBId,
        items: [
          { productId, batchId: validBatchId, unitId: tabletId, quantity: 100 },
          { productId, batchId: expiredBatchId, unitId: tabletId, quantity: 10 },
        ],
      })
      .expect(201);
    const transferId = create.body.data.id as string;

    const before = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId: validBatchId, locationId: locationAId } },
    });
    expect(before?.quantity.toNumber()).toBe(500);

    // Completing fails because the destination IN of the expired batch is
    // rejected — after the valid item's OUT+IN already ran inside the tx.
    const res = await request(app)
      .post(`/api/v1/inventory/transfers/${transferId}/complete`)
      .set("Cookie", cookie)
      .expect(409);
    expect(res.body.error.code).toBe("EXPIRED_BATCH");

    // Everything rolled back:
    // - transfer is still DRAFT
    const transfer = await prisma.stockTransfer.findUnique({ where: { id: transferId } });
    expect(transfer?.status).toBe("DRAFT");

    // - no stock was moved (source unchanged, destination untouched)
    const after = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId: validBatchId, locationId: locationAId } },
    });
    expect(after?.quantity.toNumber()).toBe(500);
    const dest = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId: validBatchId, locationId: locationBId } },
    });
    expect(dest).toBeNull();

    // - no stock transactions were written for this transfer
    const txns = await prisma.stockTransaction.count({ where: { referenceId: transferId } });
    expect(txns).toBe(0);
  });
});