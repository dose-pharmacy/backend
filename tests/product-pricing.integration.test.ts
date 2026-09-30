import { Prisma } from "@prisma/client";
import type { PurchaseOrderStatus } from "@prisma/client";
import request from "supertest";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";
import { computeProductPricing } from "../src/services/inventory/pricing.service.js";

/**
 * Product pricing / target-margin warning.
 *
 * Seeds a small catalogue with known selling prices, group margins and
 * confirmed goods receipts (directly, so the test stays focused on pricing
 * rather than re-testing the receiving flow), then asserts the warning on the
 * product detail endpoint, on the product list, and through the
 * `?pricingStatus=` filter — including database-side pagination and the
 * cancelled / unreceived exclusions.
 *
 * End-to-end against a remote database: give it room.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const BASE = "/api/v1/inventory";

type PricingPayload = {
  sellingPrice: number | null;
  targetMargin: number | null;
  costBasis: number | null;
  targetSellingPrice: number | null;
  pricingStatus: string;
};

type ListItem = {
  id: string;
  sku: string;
  isActive: boolean;
  productGroup: { id: string; name: string };
  pricing: PricingPayload;
};

type Fixture = { id: string; sku: string; expected: PricingPayload };

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
}

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((c) => c.startsWith("better-auth.session_token"));
}

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(String(value));
}

describe("inventory: product pricing / target-margin warning", () => {
  let cookie = "";
  let userId = "";
  let locationId = "";
  let supplierA = "";
  let supplierB = "";
  let baseUnitId = "";
  let boxUnitId = "";
  let mainGroupId = "";
  let zeroGroupId = "";

  const suffix = uniqueSuffix();
  const fixtures = new Map<string, Fixture>();
  const productIds: string[] = [];
  const poIds: string[] = [];

  async function addReceivedCost(params: {
    productId: string;
    unitCost: number;
    supplierId: string;
    unitId?: string;
    conversionFactor?: number;
    quantityOrdered?: number;
    poStatus?: PurchaseOrderStatus;
    confirmed?: boolean;
    batchId?: string;
  }): Promise<void> {
    const tag = uniqueSuffix();
    const quantityOrdered = params.quantityOrdered ?? 10;
    const factor = params.conversionFactor ?? 1;

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-PRC-${tag}`,
        supplierId: params.supplierId,
        createdById: userId,
        status: params.poStatus ?? "RECEIVED",
      },
    });
    poIds.push(po.id);

    const poItem = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: params.productId,
        unitId: params.unitId ?? baseUnitId,
        quantityOrdered,
        quantityOrderedBase: quantityOrdered * factor,
        quantityReceived: quantityOrdered,
        unitCost: params.unitCost,
      },
    });

    const receipt = await prisma.goodsReceipt.create({
      data: {
        receiptNumber: `GR-PRC-${tag}`,
        purchaseOrderId: po.id,
        supplierId: params.supplierId,
        createdById: userId,
        // `confirmedById` is the "this delivery really happened" gate.
        confirmedById: params.confirmed === false ? null : userId,
        status: "MATCHED",
      },
    });

    await prisma.goodsReceiptItem.create({
      data: {
        goodsReceiptId: receipt.id,
        purchaseOrderItemId: poItem.id,
        locationId,
        expectedQty: quantityOrdered,
        deliveredQty: quantityOrdered,
        actualQty: quantityOrdered,
        unitCost: params.unitCost,
        unitId: params.unitId ?? baseUnitId,
        batchId: params.batchId ?? null,
      },
    });
  }

  async function createProduct(params: {
    key: string;
    groupId: string;
    sellPrice: number;
    isActive?: boolean;
    extraUnits?: { unitId: string; conversionFactor: number }[];
    expected: PricingPayload;
  }): Promise<void> {
    const sku = `PRC-${params.key}-${suffix}`;
    const product = await prisma.product.create({
      data: {
        name: `Pricing ${params.key} ${suffix}`,
        sku,
        productGroupId: params.groupId,
        isActive: params.isActive ?? true,
        units: {
          create: [
            {
              unitId: baseUnitId,
              conversionFactor: 1,
              isBaseUnit: true,
              sellPrice: params.sellPrice,
            },
            ...(params.extraUnits ?? []).map((extra) => ({
              unitId: extra.unitId,
              conversionFactor: extra.conversionFactor,
              sellPrice: null,
            })),
          ],
        },
      },
      select: { id: true },
    });
    productIds.push(product.id);
    fixtures.set(params.key, { id: product.id, sku, expected: params.expected });
  }

  beforeAll(async () => {
    const email = `product-pricing.${suffix}@example.com`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Pricing Admin", email, password: "ValidPass1" })
      .expect(200);
    const session = sessionCookie(signUp);
    if (!session) throw new Error("Expected a session cookie after sign up");
    cookie = session;
    userId = signUp.body.user.id as string;

    const [mainGroup, zeroGroup, baseUnit, boxUnit, location, supA, supB] = await Promise.all([
      prisma.productGroup.create({
        data: { name: `Pricing Group ${suffix}`, defaultProfitMargin: 10 },
      }),
      prisma.productGroup.create({
        data: { name: `Pricing Zero Margin ${suffix}`, defaultProfitMargin: 0 },
      }),
      prisma.unit.create({ data: { name: `Pricing Tablet ${suffix}`, symbol: `PT-${suffix.slice(-4)}` } }),
      prisma.unit.create({ data: { name: `Pricing Box ${suffix}`, symbol: `PB-${suffix.slice(-4)}` } }),
      prisma.inventoryLocation.create({ data: { name: `Pricing Store ${suffix}` } }),
      prisma.supplier.create({ data: { name: `Pricing Supplier A ${suffix}` } }),
      prisma.supplier.create({ data: { name: `Pricing Supplier B ${suffix}` } }),
    ]);
    mainGroupId = mainGroup.id;
    zeroGroupId = zeroGroup.id;
    baseUnitId = baseUnit.id;
    boxUnitId = boxUnit.id;
    locationId = location.id;
    supplierA = supA.id;
    supplierB = supB.id;

    // 1. selling above target ------------------------------------------------
    await createProduct({
      key: "OK",
      groupId: mainGroupId,
      sellPrice: 150,
      expected: {
        sellingPrice: 150,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "OK",
      },
    });
    await addReceivedCost({ productId: fixtures.get("OK")!.id, unitCost: 120, supplierId: supplierA });

    // 2. selling exactly at target ------------------------------------------
    await createProduct({
      key: "AT_TARGET",
      groupId: mainGroupId,
      sellPrice: 133.33,
      expected: {
        sellingPrice: 133.33,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "OK",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("AT_TARGET")!.id,
      unitCost: 120,
      supplierId: supplierA,
    });

    // 3. above cost, below target -------------------------------------------
    await createProduct({
      key: "BELOW_TARGET",
      groupId: mainGroupId,
      sellPrice: 130,
      expected: {
        sellingPrice: 130,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "BELOW_TARGET",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("BELOW_TARGET")!.id,
      unitCost: 120,
      supplierId: supplierA,
    });

    // 4. selling under cost --------------------------------------------------
    await createProduct({
      key: "BELOW_COST",
      groupId: mainGroupId,
      sellPrice: 100,
      expected: {
        sellingPrice: 100,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "BELOW_COST",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("BELOW_COST")!.id,
      unitCost: 120,
      supplierId: supplierA,
    });

    // 5. selling exactly at cost --------------------------------------------
    await createProduct({
      key: "AT_COST",
      groupId: mainGroupId,
      sellPrice: 120,
      expected: {
        sellingPrice: 120,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "BELOW_COST",
      },
    });
    await addReceivedCost({ productId: fixtures.get("AT_COST")!.id, unitCost: 120, supplierId: supplierA });

    // 6. no configured margin ------------------------------------------------
    await createProduct({
      key: "NO_MARGIN",
      groupId: zeroGroupId,
      sellPrice: 100,
      expected: {
        sellingPrice: 100,
        targetMargin: 0,
        costBasis: 120,
        targetSellingPrice: null,
        pricingStatus: "NO_MARGIN_CONFIG",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("NO_MARGIN")!.id,
      unitCost: 120,
      supplierId: supplierA,
    });

    // 7. no received purchase history ---------------------------------------
    await createProduct({
      key: "NO_COST",
      groupId: mainGroupId,
      sellPrice: 100,
      expected: {
        sellingPrice: 100,
        targetMargin: 10,
        costBasis: null,
        targetSellingPrice: null,
        pricingStatus: "NO_PURCHASE_COST",
      },
    });

    // 8. several suppliers / batches at different prices -> highest wins -----
    await createProduct({
      key: "HIGHEST",
      groupId: mainGroupId,
      sellPrice: 130,
      expected: {
        sellingPrice: 130,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "BELOW_TARGET",
      },
    });
    const highestId = fixtures.get("HIGHEST")!.id;
    const batches = await Promise.all(
      [100, 120, 115].map((cost, index) =>
        prisma.batch.create({
          data: {
            productId: highestId,
            batchNumber: `PRC-B${index}-${suffix}`,
            expiryDate: new Date("2032-06-30"),
            purchaseCost: cost,
            supplierId: index === 1 ? supplierB : supplierA,
          },
          select: { id: true },
        }),
      ),
    );
    // Cheapest first, so the MAX really has to pick the middle supplier.
    await addReceivedCost({
      productId: highestId,
      unitCost: 100,
      supplierId: supplierA,
      batchId: batches[0].id,
    });
    await addReceivedCost({
      productId: highestId,
      unitCost: 120,
      supplierId: supplierB,
      batchId: batches[1].id,
    });
    await addReceivedCost({
      productId: highestId,
      unitCost: 115,
      supplierId: supplierA,
      batchId: batches[2].id,
    });

    // 9. purchase-unit price converted to the base unit ---------------------
    await createProduct({
      key: "CONVERTED",
      groupId: mainGroupId,
      sellPrice: 10.5,
      extraUnits: [{ unitId: boxUnitId, conversionFactor: 24 }],
      expected: {
        sellingPrice: 10.5,
        targetMargin: 10,
        costBasis: 10,
        targetSellingPrice: 11.11,
        pricingStatus: "BELOW_TARGET",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("CONVERTED")!.id,
      unitCost: 240, // per Box (24 base units) -> 10 per base unit
      supplierId: supplierA,
      unitId: boxUnitId,
      conversionFactor: 24,
      quantityOrdered: 1,
    });

    // 10. cancelled purchase orders never count -----------------------------
    await createProduct({
      key: "CANCELLED_PO",
      groupId: mainGroupId,
      sellPrice: 100,
      expected: {
        sellingPrice: 100,
        targetMargin: 10,
        costBasis: null,
        targetSellingPrice: null,
        pricingStatus: "NO_PURCHASE_COST",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("CANCELLED_PO")!.id,
      unitCost: 500,
      supplierId: supplierA,
      poStatus: "CANCELLED",
    });

    // 11. unconfirmed (never received) deliveries never count ---------------
    await createProduct({
      key: "UNCONFIRMED",
      groupId: mainGroupId,
      sellPrice: 100,
      expected: {
        sellingPrice: 100,
        targetMargin: 10,
        costBasis: null,
        targetSellingPrice: null,
        pricingStatus: "NO_PURCHASE_COST",
      },
    });
    await addReceivedCost({
      productId: fixtures.get("UNCONFIRMED")!.id,
      unitCost: 500,
      supplierId: supplierA,
      confirmed: false,
    });

    // 12. no stock on hand, but valid purchase history -> still priced ------
    await createProduct({
      key: "NO_STOCK",
      groupId: mainGroupId,
      sellPrice: 150,
      expected: {
        sellingPrice: 150,
        targetMargin: 10,
        costBasis: 120,
        targetSellingPrice: 133.33,
        pricingStatus: "OK",
      },
    });
    await addReceivedCost({ productId: fixtures.get("NO_STOCK")!.id, unitCost: 120, supplierId: supplierA });

    // 13. inactive product --------------------------------------------------
    await createProduct({
      key: "INACTIVE_NO_COST",
      groupId: mainGroupId,
      sellPrice: 100,
      isActive: false,
      expected: {
        sellingPrice: 100,
        targetMargin: 10,
        costBasis: null,
        targetSellingPrice: null,
        pricingStatus: "NO_PURCHASE_COST",
      },
    });

    // 14. no unit configuration at all (unpriced, but with a received cost) --
    const unitless = await prisma.product.create({
      data: {
        name: `Pricing NO_UNIT ${suffix}`,
        sku: `PRC-NO_UNIT-${suffix}`,
        productGroupId: mainGroupId,
      },
      select: { id: true },
    });
    productIds.push(unitless.id);
    fixtures.set("NO_UNIT", {
      id: unitless.id,
      sku: `PRC-NO_UNIT-${suffix}`,
      expected: {
        sellingPrice: null,
        targetMargin: 10,
        costBasis: 5,
        targetSellingPrice: 5.56,
        pricingStatus: "BELOW_COST",
      },
    });
    await addReceivedCost({ productId: unitless.id, unitCost: 5, supplierId: supplierA });
  });

  afterAll(async () => {
    await prisma.goodsReceiptItem.deleteMany({
      where: { purchaseOrderItem: { purchaseOrderId: { in: poIds } } },
    });
    await prisma.goodsReceipt.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.batch.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: [baseUnitId, boxUnitId] } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: [mainGroupId, zeroGroupId] } } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierA, supplierB] } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function listProducts(query: string) {
    const res = await request(app)
      .get(`${BASE}/products?${query}`)
      .set("Cookie", cookie)
      .expect(200);
    return res.body as {
      data: ListItem[];
      meta: { page: number; limit: number; total: number; totalPages: number };
      summary: {
        byStatus: { active: number; inactive: number };
        byProductGroup: { productGroupId: string; count: number }[];
      };
    };
  }

  function keysOf(items: ListItem[]): string[] {
    const keyById = new Map([...fixtures.entries()].map(([key, fixture]) => [fixture.id, key]));
    return items
      .map((item) => keyById.get(item.id) ?? `unknown:${item.sku}`)
      .sort();
  }

  it("reports the pricing warning on product detail", async () => {
    for (const [key, fixture] of fixtures) {
      const res = await request(app)
        .get(`${BASE}/products/${fixture.id}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(res.body.data.pricing, `fixture ${key}`).toEqual(fixture.expected);
    }
  });

  it("keeps targetSellingPrice at currency precision (no floating point noise)", () => {
    expect(fixtures.get("OK")!.expected.targetSellingPrice).toBe(133.33);
    expect(fixtures.get("CONVERTED")!.expected.targetSellingPrice).toBe(11.11);
  });

  it("never reprices the product", async () => {
    const ok = fixtures.get("OK")!;
    const unit = await prisma.productUnit.findFirst({
      where: { productId: ok.id, isBaseUnit: true },
    });
    expect(unit?.sellPrice?.toString()).toBe("150");
  });

  it("includes the pricing warning on every list item", async () => {
    const { data, meta } = await listProducts(`search=${suffix}&limit=100`);
    expect(meta.total).toBe(fixtures.size);
    expect(data).toHaveLength(fixtures.size);

    const keyById = new Map([...fixtures.entries()].map(([key, fixture]) => [fixture.id, key]));
    for (const item of data) {
      const key = keyById.get(item.id) as string;
      expect(key, item.sku).toBeTruthy();
      expect(item.pricing).toEqual(fixtures.get(key)!.expected);
      // Decimals are serialized as numbers by the API convention.
      expect(typeof item.pricing.targetMargin).toBe("number");
      expect(item.productGroup.id).toBeTruthy();
    }
  });

  it("agrees with the in-memory rule engine for every seeded product", async () => {
    const { data } = await listProducts(`search=${suffix}&limit=100`);
    for (const item of data) {
      const recomputed = computeProductPricing({
        sellingPrice:
          item.pricing.sellingPrice === null ? null : decimal(item.pricing.sellingPrice),
        targetMargin: item.pricing.targetMargin === null ? null : decimal(item.pricing.targetMargin),
        costBasis: item.pricing.costBasis === null ? null : decimal(item.pricing.costBasis),
      });
      expect(recomputed.pricingStatus).toBe(item.pricing.pricingStatus);
    }
  });

  it("filters by pricingStatus=OK", async () => {
    const { data, meta } = await listProducts(`search=${suffix}&pricingStatus=OK&limit=100`);
    expect(keysOf(data)).toEqual(["AT_TARGET", "NO_STOCK", "OK"]);
    expect(meta.total).toBe(3);
  });

  it("filters by pricingStatus=BELOW_TARGET", async () => {
    const { data } = await listProducts(`search=${suffix}&pricingStatus=BELOW_TARGET&limit=100`);
    expect(keysOf(data)).toEqual(["BELOW_TARGET", "CONVERTED", "HIGHEST"]);
  });

  it("filters by pricingStatus=BELOW_COST (an unpriced product cannot cover cost)", async () => {
    const { data } = await listProducts(`search=${suffix}&pricingStatus=BELOW_COST&limit=100`);
    expect(keysOf(data)).toEqual(["AT_COST", "BELOW_COST", "NO_UNIT"]);
  });

  it("filters by pricingStatus=NO_MARGIN_CONFIG", async () => {
    const { data } = await listProducts(
      `search=${suffix}&pricingStatus=NO_MARGIN_CONFIG&limit=100`,
    );
    expect(keysOf(data)).toEqual(["NO_MARGIN"]);
  });

  it("filters by pricingStatus=NO_PURCHASE_COST (cancelled + unreceived excluded from cost)", async () => {
    const { data } = await listProducts(
      `search=${suffix}&pricingStatus=NO_PURCHASE_COST&limit=100`,
    );
    expect(keysOf(data)).toEqual([
      "CANCELLED_PO",
      "INACTIVE_NO_COST",
      "NO_COST",
      "UNCONFIRMED",
    ]);
  });

  it("treats pricingStatus=ALL as no filter", async () => {
    const { data, meta } = await listProducts(`search=${suffix}&pricingStatus=ALL&limit=100`);
    expect(meta.total).toBe(fixtures.size);
    expect(data).toHaveLength(fixtures.size);
  });

  it("rejects an unknown pricingStatus", async () => {
    const res = await request(app)
      .get(`${BASE}/products?pricingStatus=BOGUS`)
      .set("Cookie", cookie)
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("combines the pricing filter with the existing filters", async () => {
    const byGroup = await listProducts(
      `search=${suffix}&pricingStatus=NO_MARGIN_CONFIG&productGroupId=${zeroGroupId}&limit=100`,
    );
    expect(keysOf(byGroup.data)).toEqual(["NO_MARGIN"]);

    const activeOnly = await listProducts(
      `search=${suffix}&pricingStatus=NO_PURCHASE_COST&isActive=true&limit=100`,
    );
    expect(keysOf(activeOnly.data)).toEqual(["CANCELLED_PO", "NO_COST", "UNCONFIRMED"]);

    const inactiveOnly = await listProducts(
      `search=${suffix}&pricingStatus=NO_PURCHASE_COST&isActive=false&limit=100`,
    );
    expect(keysOf(inactiveOnly.data)).toEqual(["INACTIVE_NO_COST"]);

    const scoped = await listProducts(
      `search=${suffix}&pricingStatus=BELOW_TARGET&productGroupId=${mainGroupId}&limit=100`,
    );
    expect(keysOf(scoped.data)).toEqual(["BELOW_TARGET", "CONVERTED", "HIGHEST"]);
  });

  it("filters BEFORE paginating (pages are complete and disjoint)", async () => {
    const first = await listProducts(`search=${suffix}&pricingStatus=OK&limit=2&page=1`);
    expect(first.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(first.data).toHaveLength(2);

    const second = await listProducts(`search=${suffix}&pricingStatus=OK&limit=2&page=2`);
    expect(second.data).toHaveLength(1);

    const ids = [...first.data, ...second.data].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(keysOf([...first.data, ...second.data])).toEqual(["AT_TARGET", "NO_STOCK", "OK"]);

    // The summary describes the whole filtered set, not just the page.
    expect(first.summary.byStatus).toEqual({ active: 3, inactive: 0 });
  });

  it("keeps the summary consistent with the pricing filter", async () => {
    const { data, summary } = await listProducts(
      `search=${suffix}&pricingStatus=NO_PURCHASE_COST&limit=100`,
    );
    expect(summary.byStatus).toEqual({ active: 3, inactive: 1 });
    const groupTotal = summary.byProductGroup.reduce((sum, row) => sum + row.count, 0);
    expect(groupTotal).toBe(data.length);
  });

  it("requires authentication", async () => {
    await request(app).get(`${BASE}/products?pricingStatus=OK`).expect(401);
  });

  it("rejects a non-admin role (pricing follows the existing permission model)", async () => {
    const other = await request(app)
      .post("/api/auth/sign-up/email")
      .send({
        name: "Pricing Pharmacist",
        email: `product-pricing-role.${suffix}@example.com`,
        password: "ValidPass1",
      })
      .expect(200);
    const otherCookie = sessionCookie(other);
    if (!otherCookie) throw new Error("Expected a session cookie");
    const otherId = other.body.user.id as string;
    await prisma.user.update({ where: { id: otherId }, data: { role: "PHARMACIST" } });

    try {
      const list = await request(app)
        .get(`${BASE}/products?pricingStatus=OK`)
        .set("Cookie", otherCookie)
        .expect(403);
      expect(list.body.error.code).toBe("FORBIDDEN");

      const detail = await request(app)
        .get(`${BASE}/products/${fixtures.get("OK")!.id}`)
        .set("Cookie", otherCookie)
        .expect(403);
      expect(detail.body.error.code).toBe("FORBIDDEN");
    } finally {
      await prisma.user.deleteMany({ where: { id: otherId } });
    }
  });
});
