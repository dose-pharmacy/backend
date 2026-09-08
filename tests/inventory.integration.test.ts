import { Prisma } from "@prisma/client";
import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { UserRole } from "../src/authorization/roles.js";
import { prisma } from "../src/database/prisma.js";
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

const FUTURE_EXPIRY = "2032-06-30";

describe("inventory: product groups", () => {
  let cookie: string;
  let userId: string;
  const groupIds: string[] = [];
  const productIds: string[] = [];

  beforeAll(async () => {
    const admin = await signUpUser("inv-groups");
    cookie = admin.cookie;
    userId = admin.userId;
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/v1/inventory/product-groups").expect(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("denies a non-admin role with 403", async () => {
    const other = await signUpUser("inv-pharmacist");
    await prisma.user.update({
      where: { id: other.userId },
      data: { role: UserRole.PHARMACIST },
    });
    const res = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", other.cookie)
      .send({ name: "Blocked" })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    await prisma.user.delete({ where: { id: other.userId } });
  });

  it("creates a product group", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Painkillers", description: "Analgesics", defaultProfitMargin: 25.5 })
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("Painkillers");
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.defaultProfitMargin).toBe(25.5);
    groupIds.push(res.body.data.id as string);
  });

  it("prevents duplicate product group names (case-insensitive)", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "painkillers" })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_PRODUCT_GROUP");
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "  " })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("lists and searches product groups", async () => {
    await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Antibiotics" })
      .expect(201)
      .then((res) => groupIds.push(res.body.data.id as string));

    const search = await request(app)
      .get("/api/v1/inventory/product-groups?search=antibio")
      .set("Cookie", cookie)
      .expect(200);
    expect(search.body.meta.total).toBe(1);
    expect(search.body.data[0].name).toBe("Antibiotics");
  });

  it("updates and deactivates a product group", async () => {
    const id = groupIds[0];
    const res = await request(app)
      .patch(`/api/v1/inventory/product-groups/${id}`)
      .set("Cookie", cookie)
      .send({ isActive: false, description: "Updated" })
      .expect(200);
    expect(res.body.data.isActive).toBe(false);

    const filtered = await request(app)
      .get("/api/v1/inventory/product-groups?isActive=false")
      .set("Cookie", cookie)
      .expect(200);
    expect(filtered.body.data.some((g: { id: string }) => g.id === id)).toBe(true);
  });

  it("blocks deletion while products depend on the group", async () => {
    const groupRes = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Vitamins" })
      .expect(201);
    const groupId = groupRes.body.data.id as string;
    groupIds.push(groupId);

    const productRes = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Vitamin C",
        sku: `VIT-C-${Date.now()}`,
        productGroupId: groupId,
      })
      .expect(201);
    productIds.push(productRes.body.data.id as string);

    const del = await request(app)
      .delete(`/api/v1/inventory/product-groups/${groupId}`)
      .set("Cookie", cookie)
      .expect(409);
    expect(del.body.error.code).toBe("PRODUCT_GROUP_IN_USE");
  });

  it("allows deletion once the group is empty", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Empty Group" })
      .expect(201);
    const groupId = res.body.data.id as string;

    await request(app)
      .delete(`/api/v1/inventory/product-groups/${groupId}`)
      .set("Cookie", cookie)
      .expect(200);
  });
});

describe("inventory: products", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];

  beforeAll(async () => {
    const admin = await signUpUser("inv-products");
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
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("creates a product with a product group", async () => {
    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Analgesics" })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Paracetamol 500mg",
        genericName: "Paracetamol",
        brand: "Generic",
        sku: `PCM-${Date.now()}`,
        productGroupId: group.body.data.id,
        minimumStock: 100,
      })
      .expect(201);
    expect(res.body.data.productGroupId).toBe(group.body.data.id);
    expect(res.body.data.minimumStock).toBe(100);
    productIds.push(res.body.data.id as string);
  });

  it("prevents duplicate SKUs", async () => {
    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Duplicate Group" })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const sku = `DUP-${Date.now()}`;
    await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name: "First", sku, productGroupId: group.body.data.id })
      .expect(201)
      .then((res) => productIds.push(res.body.data.id as string));

    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name: "Second", sku, productGroupId: group.body.data.id })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_SKU");
  });

  it("rejects a product whose group does not exist", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Orphan",
        sku: `ORPHAN-${Date.now()}`,
        productGroupId: "00000000-0000-4000-8000-000000000000",
      })
      .expect(404);
    expect(res.body.error.code).toBe("PRODUCT_GROUP_NOT_FOUND");
  });

  it("searches and filters products", async () => {
    const list = await request(app)
      .get("/api/v1/inventory/products?search=paracetamol")
      .set("Cookie", cookie)
      .expect(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(list.body.data[0].name).toBe("Paracetamol 500mg");
  });

  it("returns product detail with stock summary of zero", async () => {
    const id = productIds[0];
    const res = await request(app)
      .get(`/api/v1/inventory/products/${id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.units).toEqual([]);
    expect(res.body.data.stockSummary.totalQuantity).toBe(0);
    expect(res.body.data.productGroup.name).toBeDefined();
  });

  it("blocks deletion once the product has units or batches", async () => {
    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Temp Group" })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({
        name: "Delete Me",
        sku: `DEL-${Date.now()}`,
        productGroupId: group.body.data.id,
      })
      .expect(201);
    const productId = product.body.data.id as string;
    productIds.push(productId);

    await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Tablet", conversionFactor: 1, isBaseUnit: true })
      .expect(201);

    const res = await request(app)
      .delete(`/api/v1/inventory/products/${productId}`)
      .set("Cookie", cookie)
      .expect(409);
    expect(res.body.error.code).toBe("PRODUCT_IN_USE");
  });
});

describe("inventory: units & conversion", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const unitIds: string[] = [];

  let baseUnitId: string;
  let stripUnitId: string;
  let boxUnitId: string;
  let productId: string;

  async function makeProduct(name: string, skuSuffix: string): Promise<string> {
    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Group ${name} ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);
    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name, sku: `${skuSuffix}-${Date.now()}`, productGroupId: group.body.data.id })
      .expect(201);
    productIds.push(product.body.data.id as string);
    return product.body.data.id as string;
  }

  beforeAll(async () => {
    const admin = await signUpUser("inv-units");
    cookie = admin.cookie;
    userIds.push(admin.userId);

    productId = await makeProduct("Aspirin", "ASP");
    const base = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Tablet", conversionFactor: 1, isBaseUnit: true })
      .expect(201);
    baseUnitId = base.body.data.id as string;
    unitIds.push(baseUnitId);

    const strip = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Strip", conversionFactor: 10, sellPrice: 5.0 })
      .expect(201);
    stripUnitId = strip.body.data.id as string;
    unitIds.push(stripUnitId);
    void stripUnitId;

    const box = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Box", conversionFactor: 100 })
      .expect(201);
    boxUnitId = box.body.data.id as string;
    unitIds.push(boxUnitId);
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("rejects a second base unit for the same product", async () => {
    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Piece", conversionFactor: 1, isBaseUnit: true })
      .expect(409);
    expect(res.body.error.code).toBe("BASE_UNIT_EXISTS");
  });

  it("rejects duplicate unit names", async () => {
    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Strip", conversionFactor: 20 })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_UNIT");
  });

  it("rejects invalid conversion factors", async () => {
    const negative = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Bad", conversionFactor: -5 })
      .expect(422);
    expect(negative.body.error.code).toBe("VALIDATION_ERROR");

    const baseWithWrongFactor = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "BadBase", conversionFactor: 2, isBaseUnit: true })
      .expect(422);
    expect(baseWithWrongFactor.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("converts between units via the base unit", async () => {
    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units/convert`)
      .set("Cookie", cookie)
      .send({ quantity: 2, fromUnitId: boxUnitId, toUnitId: baseUnitId })
      .expect(200);
    expect(res.body.data.convertedQuantity).toBe(200);
    expect(res.body.data.fromUnit).toBe("Box");
    expect(res.body.data.toUnit).toBe("Tablet");

    const reverse = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units/convert`)
      .set("Cookie", cookie)
      .send({ quantity: 200, fromUnitId: baseUnitId, toUnitId: boxUnitId })
      .expect(200);
    expect(reverse.body.data.convertedQuantity).toBe(2);
  });

  it("rejects a unit from another product in a conversion", async () => {
    const otherProductId = await makeProduct("Ibuprofen", "IBU");
    const otherUnit = await request(app)
      .post(`/api/v1/inventory/products/${otherProductId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Tablet", conversionFactor: 1, isBaseUnit: true })
      .expect(201);
    unitIds.push(otherUnit.body.data.id as string);

    const res = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units/convert`)
      .set("Cookie", cookie)
      .send({
        quantity: 1,
        fromUnitId: baseUnitId,
        toUnitId: otherUnit.body.data.id,
      })
      .expect(422);
    expect(res.body.error.code).toBe("UNIT_PRODUCT_MISMATCH");
  });

  it("protects the base unit from deletion", async () => {
    const res = await request(app)
      .delete(`/api/v1/inventory/products/${productId}/units/${baseUnitId}`)
      .set("Cookie", cookie)
      .expect(409);
    expect(res.body.error.code).toBe("BASE_UNIT_FORBIDDEN");
  });

  it("prevents changing the base unit conversion factor", async () => {
    const res = await request(app)
      .patch(`/api/v1/inventory/products/${productId}/units/${baseUnitId}`)
      .set("Cookie", cookie)
      .send({ conversionFactor: 2 })
      .expect(409);
    expect(res.body.error.code).toBe("BASE_UNIT_FORBIDDEN");
  });

  it("lists units of a product", async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.map((u: { name: string }) => u.name)).toEqual(
      expect.arrayContaining(["Tablet", "Strip", "Box"]),
    );
  });

  it("allows deleting a non-base unit with no history", async () => {
    const extra = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Sachet", conversionFactor: 5 })
      .expect(201);
    const extraId = extra.body.data.id as string;

    await request(app)
      .delete(`/api/v1/inventory/products/${productId}/units/${extraId}`)
      .set("Cookie", cookie)
      .expect(200);
    unitIds.splice(unitIds.indexOf(extraId), 1);
  });

});

describe("inventory: locations", () => {
  let cookie: string;
  const userIds: string[] = [];
  const locationIds: string[] = [];

  beforeAll(async () => {
    const admin = await signUpUser("inv-locations");
    cookie = admin.cookie;
    userIds.push(admin.userId);
  });

  afterAll(async () => {
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("creates locations", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: "Main Store", description: "Primary dispensing area" })
      .expect(201);
    locationIds.push(res.body.data.id as string);
    expect(res.body.data.isActive).toBe(true);
  });

  it("prevents duplicate location names", async () => {
    await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: "Dispensing Area" })
      .expect(201)
      .then((res) => locationIds.push(res.body.data.id as string));

    const res = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: "dispensing area" })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_LOCATION");
  });

  it("deactivates a location", async () => {
    const res = await request(app)
      .patch(`/api/v1/inventory/locations/${locationIds[0]}`)
      .set("Cookie", cookie)
      .send({ isActive: false })
      .expect(200);
    expect(res.body.data.isActive).toBe(false);
  });

  it("lists with active filter", async () => {
    const inactive = await request(app)
      .get("/api/v1/inventory/locations?isActive=false")
      .set("Cookie", cookie)
      .expect(200);
    expect(inactive.body.data.length).toBe(1);
  });
});

describe("inventory: batches", () => {
  let cookie: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const batchIds: string[] = [];

  async function makeProduct(name: string, skuSuffix: string): Promise<string> {
    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Group ${name} ${Date.now()}` })
      .expect(201);
    groupIds.push(group.body.data.id as string);
    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name, sku: `${skuSuffix}-${Date.now()}`, productGroupId: group.body.data.id })
      .expect(201);
    productIds.push(product.body.data.id as string);
    return product.body.data.id as string;
  }

  beforeAll(async () => {
    const admin = await signUpUser("inv-batches");
    cookie = admin.cookie;
    userIds.push(admin.userId);
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.inventoryStock.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.batch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("creates a batch with a future expiry date", async () => {
    const productId = await makeProduct("Amoxicillin", "AMX");
    const res = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({
        productId,
        batchNumber: "AMX-2026-001",
        manufacturingDate: "2026-05-01",
        expiryDate: FUTURE_EXPIRY,
        purchaseCost: 120.5,
      })
      .expect(201);
    expect(res.body.data.batchNumber).toBe("AMX-2026-001");
    batchIds.push(res.body.data.id as string);
  });

  it("prevents duplicate batch numbers for the same product", async () => {
    const productId = await makeProduct("Ciprofloxacin", "CIP");
    await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "CIP-1", expiryDate: FUTURE_EXPIRY })
      .expect(201)
      .then((res) => batchIds.push(res.body.data.id as string));

    const res = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "cip-1", expiryDate: FUTURE_EXPIRY })
      .expect(409);
    expect(res.body.error.code).toBe("DUPLICATE_BATCH");
  });

  it("allows the same batch number for a different product", async () => {
    const productId = await makeProduct("Another Cipro", "CIP2");
    const res = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "CIP-1", expiryDate: FUTURE_EXPIRY })
      .expect(201);
    batchIds.push(res.body.data.id as string);
  });

  it("rejects an expiry date in the past", async () => {
    const productId = await makeProduct("Expired Reject", "EXP");
    const res = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "EXP-1", expiryDate: "2020-01-01" })
      .expect(422);
    expect(res.body.error.code).toBe("INVALID_EXPIRY_DATE");
  });

  it("rejects a manufacturing date after the expiry date", async () => {
    const productId = await makeProduct("Bad Dates", "BAD");
    const res = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({
        productId,
        batchNumber: "BAD-1",
        manufacturingDate: FUTURE_EXPIRY,
        expiryDate: "2031-01-01",
      })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("searches batches by number and filters by product", async () => {
    const productId = productIds[0];
    const byProduct = await request(app)
      .get(`/api/v1/inventory/batches?productId=${productId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(byProduct.body.data.length).toBe(1);

    const search = await request(app)
      .get("/api/v1/inventory/batches?search=AMX-2026")
      .set("Cookie", cookie)
      .expect(200);
    expect(search.body.meta.total).toBe(1);
  });

  it("deletes a batch that has no stock or history", async () => {
    const productId = await makeProduct("Delete Batch", "DELB");
    const batch = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "DELB-1", expiryDate: FUTURE_EXPIRY })
      .expect(201);
    const batchId = batch.body.data.id as string;

    await request(app)
      .delete(`/api/v1/inventory/batches/${batchId}`)
      .set("Cookie", cookie)
      .expect(200);
  });

  it("rejects batch creation for a missing product", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({
        productId: "00000000-0000-4000-8000-000000000000",
        batchNumber: "GHOST",
        expiryDate: FUTURE_EXPIRY,
      })
      .expect(404);
    expect(res.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("inventory: stock movements", () => {
  let cookie: string;
  let actorId: string;
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const productIds: string[] = [];
  const batchIds: string[] = [];
  const unitIds: string[] = [];
  const locationIds: string[] = [];
  const stockIds: string[] = [];
  const transactionIds: string[] = [];

  let productId: string;
  let baseUnitId: string;
  let boxUnitId: string;
  let batchId: string;
  let locationId: string;
  let otherProductId: string;
  let otherUnitId: string;

  beforeAll(async () => {
    const admin = await signUpUser("inv-stock");
    cookie = admin.cookie;
    actorId = admin.userId;
    userIds.push(actorId);

    // Primary product: Amoxicillin (base: Capsule, 1 Box = 100 Capsules).
    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Antibiotics Group" })
      .expect(201);
    groupIds.push(group.body.data.id as string);

    const product = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name: "Amoxicillin 250mg", sku: "AMX-CAP", productGroupId: group.body.data.id })
      .expect(201);
    productId = product.body.data.id as string;
    productIds.push(productId);

    const base = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Capsule", conversionFactor: 1, isBaseUnit: true })
      .expect(201);
    baseUnitId = base.body.data.id as string;
    unitIds.push(baseUnitId);

    const box = await request(app)
      .post(`/api/v1/inventory/products/${productId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Box", conversionFactor: 100 })
      .expect(201);
    boxUnitId = box.body.data.id as string;
    unitIds.push(boxUnitId);

    const batch = await request(app)
      .post("/api/v1/inventory/batches")
      .set("Cookie", cookie)
      .send({ productId, batchNumber: "AMX-B1", expiryDate: FUTURE_EXPIRY })
      .expect(201);
    batchId = batch.body.data.id as string;
    batchIds.push(batchId);

    const location = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: "Main Store A" })
      .expect(201);
    locationId = location.body.data.id as string;
    locationIds.push(locationId);

    // A second product used for mismatch/invalid-unit tests.
    const otherGroup = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: "Other Group" })
      .expect(201);
    groupIds.push(otherGroup.body.data.id as string);
    const otherProduct = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name: "Diclofenac", sku: "DIC-GEL", productGroupId: otherGroup.body.data.id })
      .expect(201);
    otherProductId = otherProduct.body.data.id as string;
    productIds.push(otherProductId);
    const otherUnit = await request(app)
      .post(`/api/v1/inventory/products/${otherProductId}/units`)
      .set("Cookie", cookie)
      .send({ name: "Tube", conversionFactor: 1, isBaseUnit: true })
      .expect(201);
    otherUnitId = otherUnit.body.data.id as string;
    unitIds.push(otherUnitId);
  });

  afterAll(async () => {
    await prisma.stockTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  function recordStock(result: Response): void {
    if (result.body.data?.stock?.id) {
      stockIds.push(result.body.data.stock.id as string);
    }
    if (result.body.data?.transaction?.id) {
      transactionIds.push(result.body.data.transaction.id as string);
    }
  }

  it("creates opening stock through the movement service", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId,
        quantity: 500,
        unitId: baseUnitId,
        notes: "Initial pharmacy inventory",
      })
      .expect(201);
    recordStock(res);
    expect(res.body.data.stock.quantity).toBe(500);
    expect(res.body.data.transaction.transactionType).toBe("OPENING");
    expect(res.body.data.transaction.direction).toBe("IN");
    expect(res.body.data.transaction.quantity).toBe(500);
    expect(res.body.data.transaction.balanceAfter).toBe(500);
    expect(res.body.data.transaction.createdById).toBe(actorId);
  });

  it("converts a non-base unit when opening stock (2 Boxes = 200 capsules)", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({ productId, batchId, locationId, quantity: 2, unitId: boxUnitId })
      .expect(201);
    recordStock(res);
    expect(res.body.data.stock.quantity).toBe(700);
    expect(res.body.data.transaction.quantity).toBe(200);
    expect(res.body.data.transaction.balanceAfter).toBe(700);
  });

  it("records an adjustment IN with the reason", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/stock-adjustments")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId,
        direction: "IN",
        quantity: 20,
        unitId: baseUnitId,
        reason: "Stock count correction",
      })
      .expect(201);
    recordStock(res);
    expect(res.body.data.stock.quantity).toBe(720);
    expect(res.body.data.transaction.transactionType).toBe("ADJUSTMENT_IN");
    expect(res.body.data.transaction.balanceAfter).toBe(720);
    expect(res.body.data.transaction.notes).toBe("Stock count correction");
  });

  it("records an adjustment OUT", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/stock-adjustments")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId,
        direction: "OUT",
        quantity: 100,
        unitId: baseUnitId,
        reason: "Damage write-off",
      })
      .expect(201);
    recordStock(res);
    expect(res.body.data.stock.quantity).toBe(620);
    expect(res.body.data.transaction.transactionType).toBe("ADJUSTMENT_OUT");
    expect(res.body.data.transaction.direction).toBe("OUT");
    expect(res.body.data.transaction.quantity).toBe(100);
    expect(res.body.data.transaction.balanceAfter).toBe(620);
  });

  it("requires a reason for adjustments", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/stock-adjustments")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId,
        direction: "IN",
        quantity: 1,
        unitId: baseUnitId,
        reason: " ",
      })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("prevents negative stock and creates no transaction", async () => {
    const before = await prisma.stockTransaction.count();
    const res = await request(app)
      .post("/api/v1/inventory/stock-adjustments")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId,
        direction: "OUT",
        quantity: 999999,
        unitId: baseUnitId,
        reason: "Oversell attempt",
      })
      .expect(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.error.details.available).toBe(620);

    const after = await prisma.stockTransaction.count();
    expect(after).toBe(before);

    const stock = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId, locationId } },
    });
    expect(stock?.quantity.toNumber()).toBe(620);
  });

  it("rejects a batch that belongs to another product", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({
        productId: otherProductId,
        batchId,
        locationId,
        quantity: 10,
        unitId: otherUnitId,
      })
      .expect(422);
    expect(res.body.error.code).toBe("BATCH_PRODUCT_MISMATCH");
  });

  it("rejects a unit that does not belong to the product", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId,
        quantity: 10,
        unitId: otherUnitId,
      })
      .expect(422);
    expect(res.body.error.code).toBe("INVALID_UNIT");
  });

  it("rejects movements to an inactive location", async () => {
    const inactive = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: "Retired Store" })
      .expect(201);
    const inactiveId = inactive.body.data.id as string;
    locationIds.push(inactiveId);
    await request(app)
      .patch(`/api/v1/inventory/locations/${inactiveId}`)
      .set("Cookie", cookie)
      .send({ isActive: false })
      .expect(200);

    const res = await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId,
        locationId: inactiveId,
        quantity: 10,
        unitId: baseUnitId,
      })
      .expect(409);
    expect(res.body.error.code).toBe("INACTIVE_LOCATION");
  });

  it("rejects stock into an already-expired batch", async () => {
    const expired = await prisma.batch.create({
      data: {
        productId,
        batchNumber: `EXP-${Date.now()}`,
        expiryDate: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    batchIds.push(expired.id);

    const res = await request(app)
      .post("/api/v1/inventory/opening-stock")
      .set("Cookie", cookie)
      .send({
        productId,
        batchId: expired.id,
        locationId,
        quantity: 10,
        unitId: baseUnitId,
      })
      .expect(409);
    expect(res.body.error.code).toBe("EXPIRED_BATCH");
  });

  it("lists current stock and product stock", async () => {
    const all = await request(app)
      .get("/api/v1/inventory/stock?search=amoxicillin")
      .set("Cookie", cookie)
      .expect(200);
    expect(all.body.meta.total).toBe(1);
    expect(all.body.data[0].quantity).toBe(620);
    expect(all.body.data[0].product.name).toBe("Amoxicillin 250mg");

    const byProduct = await request(app)
      .get(`/api/v1/inventory/products/${productId}/stock`)
      .set("Cookie", cookie)
      .expect(200);
    expect(byProduct.body.data.length).toBe(1);
    expect(byProduct.body.data[0].batch.batchNumber).toBe("AMX-B1");
  });

  it("returns paginated product transaction history", async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/products/${productId}/transactions`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.meta.total).toBe(4);
    expect(res.body.data.length).toBe(4);
    expect(res.body.data[0].transactionType).toBe("ADJUSTMENT_OUT");
    expect(res.body.data[0].balanceAfter).toBe(620);
    const types = res.body.data.map((t: { transactionType: string }) => t.transactionType);
    expect(types).toEqual(
      expect.arrayContaining(["ADJUSTMENT_IN", "ADJUSTMENT_OUT", "OPENING"]),
    );
    expect(types.filter((t: string) => t === "OPENING").length).toBe(2);
  });

  it("includes stock summary in product detail", async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/products/${productId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data.stockSummary.totalQuantity).toBe(620);
    expect(res.body.data.stockSummary.byLocation[0].quantity).toBe(620);
    expect(res.body.data.units.length).toBe(2);
  });

  it("keeps stock and transaction rows atomic when the transaction insert fails", async () => {
    const stockBefore = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId, locationId } },
    });
    const countBefore = await prisma.stockTransaction.count();

    // A non-existent user id fails the StockTransaction FK, forcing a
    // rollback of the whole movement (including the InventoryStock update).
    await expect(
      stockMovementService.recordMovement({
        productId,
        batchId,
        locationId,
        transactionType: "OPENING",
        direction: "IN",
        quantity: 5,
        actor: { id: "00000000-0000-4000-8000-000000000000" },
      }),
    ).rejects.toBeTruthy();

    const stockAfter = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId, locationId } },
    });
    const countAfter = await prisma.stockTransaction.count();
    expect(
      stockAfter?.quantity.equals(stockBefore?.quantity ?? new Prisma.Decimal(0)),
    ).toBe(true);
    expect(countAfter).toBe(countBefore);
  });

  it("prevents overselling under concurrent requests", async () => {
    // Seed a fresh batch/location with exactly 100 units directly, then fire
    // two concurrent HTTP adjustments of 60 each. The advisory lock in the
    // movement engine serialises them, so exactly one succeeds.
    const concBatch = await prisma.batch.create({
      data: {
        productId,
        batchNumber: `CONC-${Date.now()}`,
        expiryDate: new Date("2032-06-30T00:00:00.000Z"),
      },
    });
    batchIds.push(concBatch.id);

    const concLocation = await prisma.inventoryLocation.create({
      data: { name: `Conc Store ${Date.now()}` },
    });
    locationIds.push(concLocation.id);

    await stockMovementService.recordMovement({
      productId,
      batchId: concBatch.id,
      locationId: concLocation.id,
      transactionType: "OPENING",
      direction: "IN",
      quantity: 100,
      actor: { id: actorId },
    });

    const body = {
      productId,
      batchId: concBatch.id,
      locationId: concLocation.id,
      direction: "OUT",
      quantity: 60,
      unitId: baseUnitId,
      reason: "Concurrent sale",
    };

    const [first, second] = await Promise.all([
      request(app)
        .post("/api/v1/inventory/stock-adjustments")
        .set("Cookie", cookie)
        .send(body),
      request(app)
        .post("/api/v1/inventory/stock-adjustments")
        .set("Cookie", cookie)
        .send(body),
    ]);

    // Exactly one succeeds and the other fails with insufficient stock.
    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 409]);

    const stock = await prisma.inventoryStock.findUnique({
      where: {
        batchId_locationId: {
          batchId: concBatch.id,
          locationId: concLocation.id,
        },
      },
    });
    expect(stock?.quantity.toNumber()).toBe(40);
  });
});
