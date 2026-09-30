import request from "supertest";
import type { Response } from "supertest";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";
import { stockMovementService } from "../src/services/inventory/stock-movement.service.js";
import {
  billDiscountShareForItem,
  netLineTotalForItem,
  refundAmountForQuantity,
} from "../src/services/pos/sale-return.service.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function uniqueEmail(label: string): string {
  return `${label}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.com`;
}

function sessionCookie(res: Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

async function signUpUser(name: string): Promise<{ cookie: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name, email: uniqueEmail(name), password: "ValidPass1" })
    .expect(200);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error("Expected a session cookie after sign up");
  return { cookie, userId: res.body.user.id as string };
}

// ---------------------------------------------------------------------------
// Pure pricing rules (unit level)
// ---------------------------------------------------------------------------
describe("sale return: refund pricing rules", () => {
  const dec = (value: string) => new Prisma.Decimal(value);

  it("allocates the bill discount to a line in proportion to its gross amount", () => {
    // Sale: line A 500, line B 500, bill discount 100 -> each line owes 50.
    const sale = { subtotal: dec("1000"), totalDiscount: dec("100") };
    expect(billDiscountShareForItem(sale, { quantity: dec("1"), lineTotal: dec("500") }).toString()).toBe("50");
    // A small line pays a proportionally small share.
    expect(billDiscountShareForItem(sale, { quantity: dec("1"), lineTotal: dec("100") }).toString()).toBe("10");
  });

  it("never allocates a discount when the subtotal is zero", () => {
    const sale = { subtotal: dec("0"), totalDiscount: dec("50") };
    expect(billDiscountShareForItem(sale, { quantity: dec("1"), lineTotal: dec("0") }).toString()).toBe("0");
  });

  it("returns the discounted value, not the list price", () => {
    const sale = { subtotal: dec("100"), totalDiscount: dec("20") };
    const item = { quantity: dec("1"), lineTotal: dec("100") };
    expect(netLineTotalForItem(sale, item).toString()).toBe("80");
  });

  it("refunds only the returned share of a discounted line", () => {
    // 5 units, net total 400 -> 80 each; returning 2 refunds 160, not 400.
    const refund = refundAmountForQuantity({
      netLineTotal: dec("400"),
      quantitySold: dec("5"),
      alreadyReturnedQuantity: dec("0"),
      alreadyRefunded: dec("0"),
      quantityReturning: dec("2"),
    });
    expect(refund.toString()).toBe("160");
  });

  it("refunds half the line, not all of it, when exactly half is returned", () => {
    // Regression: the line only closes out when this return consumes what was
    // LEFT, so returning 5 of 10 must never refund the full line.
    const refund = refundAmountForQuantity({
      netLineTotal: dec("400"),
      quantitySold: dec("10"),
      alreadyReturnedQuantity: dec("0"),
      alreadyRefunded: dec("0"),
      quantityReturning: dec("5"),
    });
    expect(refund.toString()).toBe("200");
  });

  it("refunds the exact remaining amount when the line is closed out", () => {
    const refund = refundAmountForQuantity({
      netLineTotal: dec("400"),
      quantitySold: dec("5"),
      alreadyReturnedQuantity: dec("2"),
      alreadyRefunded: dec("160"),
      quantityReturning: dec("3"),
    });
    expect(refund.toString()).toBe("240");
  });

  it("can never refund more than the line's net value, whatever the split", () => {
    // 3 units of a 400 line: rounding must not let the three refunds exceed 400.
    let returned = dec("0");
    let refunded = dec("0");
    for (const quantity of ["1", "1", "1"]) {
      refunded = refunded.plus(
        refundAmountForQuantity({
          netLineTotal: dec("400"),
          quantitySold: dec("3"),
          alreadyReturnedQuantity: returned,
          alreadyRefunded: refunded,
          quantityReturning: dec(quantity),
        }),
      );
      returned = returned.plus(dec(quantity));
    }
    expect(refunded.lte(dec("400"))).toBe(true);
    expect(refunded.toString()).toBe("400");
  });

  it("never returns a negative refund for an over-refunded line", () => {
    const refund = refundAmountForQuantity({
      netLineTotal: dec("100"),
      quantitySold: dec("1"),
      alreadyReturnedQuantity: dec("1"),
      alreadyRefunded: dec("100"),
      quantityReturning: dec("1"),
    });
    expect(refund.toNumber()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------
describe("pos: customer product returns", () => {
  let cookie: string;
  let userId: string;

  const groupIds: string[] = [];
  const productIds: string[] = [];
  const locationIds: string[] = [];
  const unitIds: string[] = [];
  const batchIds: string[] = [];

  let mainLocationId: string;
  let otherLocationId: string;
  let tabletUnitId: string;
  let boxUnitId: string;

  // Paracetamol: 2/tablet (base), 160/box (x100)
  let paracetamolId: string;
  // Ibuprofen: 1.5/tablet
  let ibuprofenId: string;
  // Vitamin C: 5/tablet
  let vitaminCId: string;
  // Product whose only batch will be expired after the sale (restock guard).
  let expiredBatchProductId: string;

  type SellLine = {
    productId: string;
    unitId: string;
    quantity: number;
    unitPrice: number;
  };

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  async function makeUnit(name: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/units")
      .set("Cookie", cookie)
      .send({ name: `${name} Ret ${Date.now()}` })
      .expect(201);
    const id = res.body.data.id as string;
    unitIds.push(id);
    return id;
  }

  async function makeProduct(
    name: string,
    opts: {
      groupId: string;
      sku: string;
      units: Array<{ unitId: string; conversionFactor: number; sellPrice: number; isBaseUnit?: boolean }>;
    },
  ): Promise<string> {
    const res = await request(app)
      .post("/api/v1/inventory/products")
      .set("Cookie", cookie)
      .send({ name, sku: opts.sku, productGroupId: opts.groupId, units: opts.units })
      .expect(201);
    const id = res.body.data.id as string;
    productIds.push(id);
    return id;
  }

  /** Seeds a batch and OPENING stock into the main location. */
  async function seedStock(
    productId: string,
    batchNumber: string,
    quantity: number,
    options: { locationId?: string; expiryDate?: Date } = {},
  ): Promise<string> {
    const batch = await prisma.batch.create({
      data: {
        productId,
        batchNumber,
        expiryDate: options.expiryDate ?? new Date("2032-06-30T00:00:00.000Z"),
      },
    });
    batchIds.push(batch.id);
    await stockMovementService.recordMovement({
      productId,
      batchId: batch.id,
      locationId: options.locationId ?? mainLocationId,
      transactionType: "OPENING",
      direction: "IN",
      quantity,
      actor: { id: userId },
    });
    return batch.id;
  }

  /** Completes a fully-paid sale, computing the exact total server-side rules. */
  async function sell(
    items: SellLine[],
    options: { billDiscount?: { type: "PERCENTAGE" | "FIXED_AMOUNT"; value: number }; locationId?: string } = {},
  ) {
    const subtotal = round2(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
    let discount = 0;
    if (options.billDiscount) {
      discount =
        options.billDiscount.type === "PERCENTAGE"
          ? round2((subtotal * options.billDiscount.value) / 100)
          : options.billDiscount.value;
    }
    const total = round2(subtotal - discount);

    const res = await request(app)
      .post("/api/v1/pos/sales")
      .set("Cookie", cookie)
      .send({
        locationId: options.locationId ?? mainLocationId,
        items: items.map((item) => ({
          productId: item.productId,
          unitId: item.unitId,
          quantity: item.quantity,
          actualUnitPrice: item.unitPrice,
        })),
        payments: [{ method: "CASH", amount: total }],
        billDiscount: options.billDiscount,
      })
      .expect(201);
    return res.body.data as {
      id: string;
      saleNumber: string;
      totalAmount: number;
      paidAmount: number;
      subtotal: number;
      totalDiscount: number;
      items: Array<{ id: string; quantity: number; lineTotal: number; actualUnitPrice: number }>;
    };
  }

  function returnInfo(saleId: string) {
    return request(app)
      .get(`/api/v1/pos/sales/${saleId}/returns`)
      .set("Cookie", cookie);
  }

  function postReturn(saleId: string, body: unknown) {
    return request(app)
      .post(`/api/v1/pos/sales/${saleId}/returns`)
      .set("Cookie", cookie)
      .send(body);
  }

  async function stockAt(productId: string, batchId: string, locationId: string) {
    const row = await prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId, locationId } },
    });
    return row ? row.quantity.toNumber() : 0;
  }

  async function returnMovements(referenceId?: string) {
    return prisma.stockTransaction.findMany({
      where: {
        transactionType: "RETURN_IN",
        direction: "IN",
        ...(referenceId ? { referenceId } : {}),
      },
    });
  }

  /** Current stock quantity of a product at the main location (all batches). */
  async function totalStockAt(productId: string, locationId: string): Promise<number> {
    const rows = await prisma.inventoryStock.findMany({
      where: { productId, locationId },
      select: { quantity: true },
    });
    return rows.reduce((sum, row) => sum + row.quantity.toNumber(), 0);
  }

  beforeAll(async () => {
    const admin = await signUpUser("sale-return");
    cookie = admin.cookie;
    userId = admin.userId;

    const group = await request(app)
      .post("/api/v1/inventory/product-groups")
      .set("Cookie", cookie)
      .send({ name: `Ret Meds ${Date.now()}` })
      .expect(201);
    const groupId = group.body.data.id as string;
    groupIds.push(groupId);

    const main = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: `Ret Main ${Date.now()}` })
      .expect(201);
    mainLocationId = main.body.data.id as string;
    locationIds.push(mainLocationId);

    const other = await request(app)
      .post("/api/v1/inventory/locations")
      .set("Cookie", cookie)
      .send({ name: `Ret Other ${Date.now()}` })
      .expect(201);
    otherLocationId = other.body.data.id as string;
    locationIds.push(otherLocationId);

    tabletUnitId = await makeUnit("Tablet");
    boxUnitId = await makeUnit("Box");

    paracetamolId = await makeProduct("Ret Paracetamol 500mg", {
      groupId,
      sku: `RET-PCM-${Date.now()}`,
      units: [
        { unitId: tabletUnitId, conversionFactor: 1, sellPrice: 2, isBaseUnit: true },
        { unitId: boxUnitId, conversionFactor: 100, sellPrice: 160 },
      ],
    });
    ibuprofenId = await makeProduct("Ret Ibuprofen 400mg", {
      groupId,
      sku: `RET-IBU-${Date.now()}`,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 1.5, isBaseUnit: true }],
    });
    vitaminCId = await makeProduct("Ret Vitamin C", {
      groupId,
      sku: `RET-VITC-${Date.now()}`,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 5, isBaseUnit: true }],
    });
    expiredBatchProductId = await makeProduct("Ret Expired On Return", {
      groupId,
      sku: `RET-EXP-${Date.now()}`,
      units: [{ unitId: tabletUnitId, conversionFactor: 1, sellPrice: 10, isBaseUnit: true }],
    });

    // Plenty of stock: many tests in this file sell from the same product.
    await seedStock(paracetamolId, `RET-PCM-${Date.now()}`, 20000);
    await seedStock(ibuprofenId, `RET-IBU-${Date.now()}`, 5000);
    await seedStock(vitaminCId, `RET-VITC-${Date.now()}`, 5000);
    // NOTE: expiredBatchProductId is deliberately NOT seeded here. Its only
    // batch gets expired by the first expiry test, so each expiry test seeds its
    // own fresh batch instead of sharing one.
    // The second location sells independently, for the "returns always go back
    // to the ORIGINAL sale location" test.
    await seedStock(paracetamolId, `RET-PCM-OTHER-${Date.now()}`, 100, {
      locationId: otherLocationId,
    });
  });

  afterAll(async () => {
    // Returns reference the sale with ON DELETE RESTRICT, so they must go
    // before the sale they point at.
    await prisma.saleReturn.deleteMany({
      where: { sale: { is: { locationId: { in: locationIds } } } },
    });
    await prisma.sale.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.stockTransaction.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.inventoryStock.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.batch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    // Creating a product also creates its default reorder configuration, which
    // blocks deleting the product until it is removed.
    await prisma.reorderConfiguration.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // =========================================================================
  // Basic flow
  // =========================================================================
  describe("basic flow", () => {
    it("returns a whole sale item and restores inventory", async () => {
      const before = await totalStockAt(paracetamolId, mainLocationId);
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;
      expect(await totalStockAt(paracetamolId, mainLocationId)).toBe(before - 10);

      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.sale.returnable).toBe(true);
      expect(info.body.data.items[0].quantitySold).toBe(10);
      expect(info.body.data.items[0].quantityReturnable).toBe(10);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 10 }],
        refundMethod: "CASH",
      }).expect(201);

      expect(created.body.data.refundAmount).toBe(20);
      expect(created.body.data.refundMethod).toBe("CASH");
      expect(created.body.data.items[0].quantity).toBe(10);
      expect(created.body.data.items[0].refundAmount).toBe(20);
      expect(created.body.data.locationId).toBe(mainLocationId);

      expect(await totalStockAt(paracetamolId, mainLocationId)).toBe(before);
    });

    it("supports a partial return and leaves the original sale item untouched", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 3 }],
        refundMethod: "CASH",
      }).expect(201);

      expect(created.body.data.refundAmount).toBe(6);
      expect(created.body.data.items[0].quantity).toBe(3);

      // The original sale item is historical truth: unchanged.
      const saleItem = await prisma.saleItem.findUnique({ where: { id: saleItemId } });
      expect(saleItem!.quantity.toNumber()).toBe(10);
      expect(saleItem!.lineTotal.toNumber()).toBe(20);
      expect(saleItem!.actualUnitPrice.toNumber()).toBe(2);

      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.items[0].quantityReturned).toBe(3);
      expect(info.body.data.items[0].quantityReturnable).toBe(7);
      expect(info.body.data.totalRefunded).toBe(6);
    });

    it("supports several partial returns of the same sale item and then closes it out", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      for (const quantity of [3, 2, 5]) {
        const res = await postReturn(sale.id, {
          items: [{ saleItemId, quantity }],
          refundMethod: "CASH",
        }).expect(201);
        expect(res.body.data.refundAmount).toBe(quantity * 2);
      }

      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.items[0].quantityReturned).toBe(10);
      expect(info.body.data.items[0].quantityReturnable).toBe(0);
      expect(info.body.data.totalRefunded).toBe(20);
      expect(info.body.data.returns.length).toBe(3);

      // Fully returned: another return must be rejected.
      await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(422);

      // Three separate return records, and the original line still says 10.
      const returns = await prisma.saleReturn.findMany({
        where: { saleId: sale.id },
        include: { items: true },
      });
      expect(returns.length).toBe(3);
      expect(returns.every((r) => r.items.length === 1)).toBe(true);
      const saleItem = await prisma.saleItem.findUnique({ where: { id: saleItemId } });
      expect(saleItem!.quantity.toNumber()).toBe(10);
    });

    it("returns several products from one sale in a single return", async () => {
      const sale = await sell([
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 },
        { productId: ibuprofenId, unitId: tabletUnitId, quantity: 3, unitPrice: 1.5 },
        { productId: vitaminCId, unitId: tabletUnitId, quantity: 2, unitPrice: 5 },
      ]);
      const [pcm, ibu] = sale.items;

      const created = await postReturn(sale.id, {
        items: [
          { saleItemId: pcm.id, quantity: 2 },
          { saleItemId: ibu.id, quantity: 1 },
        ],
        refundMethod: "MOBILE_TRANSFER",
      }).expect(201);

      // ONE return, TWO return items.
      expect(created.body.data.items.length).toBe(2);
      expect(created.body.data.refundAmount).toBe(2 * 2 + 1 * 1.5);
      expect(created.body.data.refundMethod).toBe("MOBILE_TRANSFER");

      const info = await returnInfo(sale.id).expect(200);
      const byId = new Map(info.body.data.items.map((i: { saleItemId: string }) => [i.saleItemId, i]));
      expect(byId.get(pcm.id).quantityReturnable).toBe(3);
      expect(byId.get(ibu.id).quantityReturnable).toBe(2);
      // The untouched third line is fully returnable.
      expect(byId.get(sale.items[2].id).quantityReturned).toBe(0);
      expect(byId.get(sale.items[2].id).quantityReturnable).toBe(2);
    });

    it("returns one product while leaving the other sale lines untouched", async () => {
      const sale = await sell([
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 4, unitPrice: 2 },
        { productId: vitaminCId, unitId: tabletUnitId, quantity: 6, unitPrice: 5 },
      ]);
      const [pcm, vitc] = sale.items;

      await postReturn(sale.id, {
        items: [{ saleItemId: pcm.id, quantity: 4 }],
        refundMethod: "CASH",
      }).expect(201);

      const info = await returnInfo(sale.id).expect(200);
      const byId = new Map(info.body.data.items.map((i: { saleItemId: string }) => [i.saleItemId, i]));
      expect(byId.get(pcm.id).quantityReturned).toBe(4);
      expect(byId.get(pcm.id).quantityReturnable).toBe(0);
      expect(byId.get(vitc.id).quantityReturned).toBe(0);
      expect(byId.get(vitc.id).quantityReturnable).toBe(6);

      // No return history recorded against the untouched line.
      const returnItems = await prisma.saleReturnItem.findMany({
        where: { saleItemId: vitc.id },
      });
      expect(returnItems.length).toBe(0);
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================
  describe("validation", () => {
    it("rejects a zero quantity", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const res = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 0 }],
        refundMethod: "CASH",
      }).expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a negative quantity", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: -2 }],
        refundMethod: "CASH",
      }).expect(422);
    });

    it("rejects a quantity greater than the quantity sold", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const res = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 6 }],
        refundMethod: "CASH",
      }).expect(422);
      expect(res.body.error.code).toBe("RETURN_QUANTITY_EXCEEDS_SOLD");
    });

    it("rejects a quantity greater than the remaining returnable quantity", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      await postReturn(sale.id, { items: [{ saleItemId, quantity: 3 }], refundMethod: "CASH" }).expect(201);

      // 10 sold, 3 returned -> only 7 left.
      const res = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 8 }],
        refundMethod: "CASH",
      }).expect(422);
      expect(res.body.error.code).toBe("RETURN_QUANTITY_EXCEEDS_SOLD");
      expect(res.body.error.details.quantityReturnable).toBe(7);
    });

    it("rejects an unknown sale", async () => {
      const res = await postReturn("11111111-1111-4111-8111-111111111111", {
        items: [{ saleItemId: "22222222-2222-4222-8222-222222222222", quantity: 1 }],
        refundMethod: "CASH",
      }).expect(404);
      expect(res.body.error.code).toBe("SALE_NOT_FOUND");
    });

    it("rejects an unknown sale item", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const res = await postReturn(sale.id, {
        items: [{ saleItemId: "22222222-2222-4222-8222-222222222222", quantity: 1 }],
        refundMethod: "CASH",
      }).expect(404);
      expect(res.body.error.code).toBe("SALE_ITEM_NOT_FOUND");
    });

    it("rejects a sale item that belongs to another sale", async () => {
      const saleA = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const saleB = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);

      const res = await postReturn(saleB.id, {
        items: [{ saleItemId: saleA.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(422);
      expect(res.body.error.code).toBe("SALE_ITEM_NOT_ON_SALE");
    });

    it("rejects a return against a non-completed sale", async () => {
      // A DRAFT sale never moved stock, so there is nothing to return.
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 2, unitPrice: 2 }]);
      await prisma.sale.update({ where: { id: sale.id }, data: { status: "DRAFT" } });

      const res = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(409);
      expect(res.body.error.code).toBe("SALE_NOT_RETURNABLE");

      await prisma.sale.update({ where: { id: sale.id }, data: { status: "COMPLETED" } });
    });

    it("rejects a cancelled sale", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 2, unitPrice: 2 }]);
      await prisma.sale.update({ where: { id: sale.id }, data: { status: "CANCELLED" } });

      const res = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(409);
      expect(res.body.error.code).toBe("SALE_NOT_RETURNABLE");
    });

    it("rejects the same sale item twice in one request", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;
      const res = await postReturn(sale.id, {
        items: [
          { saleItemId, quantity: 1 },
          { saleItemId, quantity: 2 },
        ],
        refundMethod: "CASH",
      }).expect(422);
      expect(res.body.error.code).toBe("DUPLICATE_SALE_ITEM_IN_RETURN");
    });

    it("rejects an empty item list", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const res = await postReturn(sale.id, { items: [], refundMethod: "CASH" }).expect(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an unknown refund method", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "GOLD_BAR",
      }).expect(422);
    });

    it("requires authentication", async () => {
      await request(app)
        .post("/api/v1/pos/sales/11111111-1111-4111-8111-111111111111/returns")
        .send({ items: [{ saleItemId: "22222222-2222-4222-8222-222222222222", quantity: 1 }], refundMethod: "CASH" })
        .expect(401);
    });
  });

  // =========================================================================
  // Pricing
  // =========================================================================
  describe("pricing", () => {
    it("refunds the original selling price, not the current product price", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      // The product price changes AFTER the sale.
      await prisma.productUnit.update({
        where: { productId_unitId: { productId: paracetamolId, unitId: tabletUnitId } },
        data: { sellPrice: 99 },
      });

      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 2 }],
        refundMethod: "CASH",
      }).expect(201);

      // 2 x the ORIGINAL price of 2, never 2 x 99.
      expect(created.body.data.refundAmount).toBe(4);

      await prisma.productUnit.update({
        where: { productId_unitId: { productId: paracetamolId, unitId: tabletUnitId } },
        data: { sellPrice: 2 },
      });
    });

    it("refunds the discounted amount when the sale had a bill discount", async () => {
      // 10 tablets at 2 = 20, with a 20% bill discount the customer paid 16.
      const sale = await sell(
        [{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }],
        { billDiscount: { type: "PERCENTAGE", value: 20 } },
      );
      expect(sale.totalAmount).toBe(16);

      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.items[0].billDiscountShare).toBe(4);
      expect(info.body.data.items[0].netLineTotal).toBe(16);
      expect(info.body.data.items[0].netUnitPrice).toBe(1.6);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(201);
      // 1.6, not the undiscounted 2.
      expect(created.body.data.refundAmount).toBe(1.6);
    });

    it("refunds only the returned share of a discounted line", async () => {
      // 5 boxes at 80 = 400 net; returning 2 refunds 160, not the whole 400.
      const sale = await sell([{ productId: paracetamolId, unitId: boxUnitId, quantity: 5, unitPrice: 80 }]);
      expect(sale.totalAmount).toBe(400);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2 }],
        refundMethod: "CASH",
      }).expect(201);
      expect(created.body.data.refundAmount).toBe(160);
      expect(created.body.data.items[0].netUnitPrice).toBe(80);
    });

    it("splits a bill discount proportionally across returned lines", async () => {
      // Two lines of 500 each with a 100 bill discount: each line owes 50.
      // Vitamin C is sold in tablets (5 each), Paracetamol in boxes (80 each).
      const sale = await sell(
        [
          { productId: paracetamolId, unitId: boxUnitId, quantity: 1, unitPrice: 500 },
          { productId: vitaminCId, unitId: tabletUnitId, quantity: 100, unitPrice: 5 },
        ],
        { billDiscount: { type: "FIXED_AMOUNT", value: 100 } },
      );
      expect(sale.subtotal).toBe(1000);
      expect(sale.totalAmount).toBe(900);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(201);
      // 500 gross - 50 discount share = 450, not the undiscounted 500.
      expect(created.body.data.refundAmount).toBe(450);
    });

    it("refunds half a line, not the whole line, when exactly half is returned", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 5 }],
        refundMethod: "CASH",
      }).expect(201);
      // Half the line, half the money — the rest is still returnable.
      expect(created.body.data.refundAmount).toBe(10);

      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.items[0].quantityReturnable).toBe(5);
      expect(info.body.data.totalRefunded).toBe(10);

      // The second half refunds exactly what is left.
      const rest = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 5 }],
        refundMethod: "CASH",
      }).expect(201);
      expect(rest.body.data.refundAmount).toBe(10);

      const final = await returnInfo(sale.id).expect(200);
      expect(final.body.data.totalRefunded).toBe(20);
      expect(final.body.data.items[0].quantityReturnable).toBe(0);
    });

    it("never refunds more than the total of what was paid, across many partial returns", async () => {
      // 3 units of a 3.33-priced line: rounding must not overpay.
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 3, unitPrice: 3.33 }]);
      const saleItemId = sale.items[0].id;

      let refunded = 0;
      for (let i = 0; i < 3; i += 1) {
        const res = await postReturn(sale.id, {
          items: [{ saleItemId, quantity: 1 }],
          refundMethod: "CASH",
        }).expect(201);
        refunded += res.body.data.refundAmount;
      }
      expect(refunded).toBe(9.99);
      expect(refunded).toBeLessThanOrEqual(sale.totalAmount);
    });

    it("ignores a client-supplied refund amount and computes its own", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2, refundAmount: 9999 }],
        refundMethod: "CASH",
      }).expect(201);
      expect(created.body.data.refundAmount).toBe(4);
    });
  });

  // =========================================================================
  // Inventory
  // =========================================================================
  describe("inventory", () => {
    it("increases sellable stock and writes a RETURN_IN movement", async () => {
      const before = await totalStockAt(ibuprofenId, mainLocationId);
      const sale = await sell([{ productId: ibuprofenId, unitId: tabletUnitId, quantity: 8, unitPrice: 1.5 }]);
      expect(await totalStockAt(ibuprofenId, mainLocationId)).toBe(before - 8);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 5 }],
        refundMethod: "CASH",
      }).expect(201);

      expect(await totalStockAt(ibuprofenId, mainLocationId)).toBe(before - 3);

      const movements = await returnMovements(created.body.data.items[0].id);
      expect(movements.length).toBe(1);
      expect(movements[0].transactionType).toBe("RETURN_IN");
      expect(movements[0].direction).toBe("IN");
      expect(movements[0].quantity.toNumber()).toBe(5);
      expect(movements[0].locationId).toBe(mainLocationId);
      expect(movements[0].referenceType).toBe("SaleReturnItem");
      expect(movements[0].createdById).toBe(userId);
    });

    it("restores stock to the ORIGINAL sale location, never another one", async () => {
      await seedStock(vitaminCId, `RET-VITC-OTHER-${Date.now()}`, 50, { locationId: otherLocationId });

      const beforeMain = await totalStockAt(vitaminCId, mainLocationId);
      const beforeOther = await totalStockAt(vitaminCId, otherLocationId);

      const sale = await sell([{ productId: vitaminCId, unitId: tabletUnitId, quantity: 4, unitPrice: 5 }]);
      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 4 }],
        refundMethod: "CASH",
      }).expect(201);

      expect(created.body.data.locationId).toBe(mainLocationId);
      expect(await totalStockAt(vitaminCId, mainLocationId)).toBe(beforeMain);
      // The other location is untouched: the client cannot redirect a return.
      expect(await totalStockAt(vitaminCId, otherLocationId)).toBe(beforeOther);
    });

    it("returns stock to the ORIGINAL batch, not an arbitrary one", async () => {
      // Two batches for one product; FEFO sells from the earlier-expiring one.
      const earlyBatchId = await seedStock(paracetamolId, `RET-FEFO-EARLY-${Date.now()}`, 100, {
        expiryDate: new Date("2027-01-31T00:00:00.000Z"),
      });
      const lateBatchId = await seedStock(paracetamolId, `RET-FEFO-LATE-${Date.now()}`, 100, {
        expiryDate: new Date("2031-01-31T00:00:00.000Z"),
      });

      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      // The sale came out of the early-expiring batch.
      const allocations = await prisma.saleItemBatch.findMany({ where: { saleItemId } });
      expect(allocations.length).toBe(1);
      expect(allocations[0].batchId).toBe(earlyBatchId);
      const earlyAfterSale = await stockAt(paracetamolId, earlyBatchId, mainLocationId);
      const lateAfterSale = await stockAt(paracetamolId, lateBatchId, mainLocationId);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 4 }],
        refundMethod: "CASH",
      }).expect(201);

      // Exactly the original batch gained the stock back.
      expect(await stockAt(paracetamolId, earlyBatchId, mainLocationId)).toBe(earlyAfterSale + 4);
      expect(await stockAt(paracetamolId, lateBatchId, mainLocationId)).toBe(lateAfterSale);

      const returnBatches = created.body.data.items[0].batchAllocations;
      expect(returnBatches.length).toBe(1);
      expect(returnBatches[0].batchId).toBe(earlyBatchId);
      expect(returnBatches[0].baseQuantity).toBe(4);
    });

    it("does not increase sellable stock for a non-restockable return but still refunds", async () => {
      const before = await totalStockAt(ibuprofenId, mainLocationId);
      const sale = await sell([{ productId: ibuprofenId, unitId: tabletUnitId, quantity: 6, unitPrice: 1.5 }]);
      const saleItemId = sale.items[0].id;
      expect(await totalStockAt(ibuprofenId, mainLocationId)).toBe(before - 6);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 6, restock: false }],
        refundMethod: "CASH",
      }).expect(201);

      // Refund recorded...
      expect(created.body.data.refundAmount).toBe(9);
      expect(created.body.data.items[0].restock).toBe(false);
      // ...but sellable inventory is untouched.
      expect(await totalStockAt(ibuprofenId, mainLocationId)).toBe(before - 6);

      const movements = await returnMovements(created.body.data.items[0].id);
      expect(movements.length).toBe(0);

      // The returned quantity still counts as returned.
      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.items[0].quantityReturned).toBe(6);
      expect(info.body.data.items[0].quantityReturnable).toBe(0);
    });

    it("normalizes the returned quantity to base units using the sale-time conversion factor", async () => {
      const before = await totalStockAt(paracetamolId, mainLocationId);
      // 1 box = 100 tablets.
      const sale = await sell([{ productId: paracetamolId, unitId: boxUnitId, quantity: 3, unitPrice: 160 }]);
      expect(await totalStockAt(paracetamolId, mainLocationId)).toBe(before - 300);

      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(201);

      expect(created.body.data.items[0].quantity).toBe(1);
      expect(created.body.data.items[0].baseQuantity).toBe(100);
      expect(created.body.data.refundAmount).toBe(160);
      expect(await totalStockAt(paracetamolId, mainLocationId)).toBe(before - 200);
    });

    it("rejects restocking into an expired batch and keeps the return non-destructive", async () => {
      await seedStock(expiredBatchProductId, `RET-EXP-A-${Date.now()}`, 500);
      const sale = await sell([
        { productId: expiredBatchProductId, unitId: tabletUnitId, quantity: 4, unitPrice: 10 },
      ]);
      const saleItemId = sale.items[0].id;

      // The batch expires after the sale was completed.
      const batch = await prisma.saleItemBatch.findFirstOrThrow({ where: { saleItemId } });
      await prisma.batch.update({
        where: { id: batch.batchId },
        data: { expiryDate: new Date("2020-01-01T00:00:00.000Z") },
      });

      const before = await totalStockAt(expiredBatchProductId, mainLocationId);
      const res = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 2 }],
        refundMethod: "CASH",
      }).expect(409);
      expect(res.body.error.code).toBe("RETURN_BATCH_EXPIRED");

      // Nothing was written and no refund was issued.
      expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
      expect(await totalStockAt(expiredBatchProductId, mainLocationId)).toBe(before);

      // The same return succeeds as non-restockable: refund without restocking.
      const created = await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 2, restock: false }],
        refundMethod: "CASH",
      }).expect(201);
      expect(created.body.data.refundAmount).toBe(20);
      expect(await totalStockAt(expiredBatchProductId, mainLocationId)).toBe(before);
    });
  });

  // =========================================================================
  // Financial records
  // =========================================================================
  describe("financial records", () => {
    it("records the immediate refund with the chosen method", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 }]);
      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2 }],
        refundMethod: "CHECK",
        refundReference: "CHQ-9988",
        reason: "Customer return",
      }).expect(201);

      expect(created.body.data.refundMethod).toBe("CHECK");
      expect(created.body.data.refundReference).toBe("CHQ-9988");
      expect(created.body.data.reason).toBe("Customer return");
      expect(created.body.data.refundAmount).toBe(4);
      expect(created.body.data.saleId).toBe(sale.id);
      expect(created.body.data.createdById).toBe(userId);
    });

    it("leaves the original sale and its payments completely unchanged", async () => {
      const sale = await sell([
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 },
      ]);
      const saleItemId = sale.items[0].id;

      const paymentsBefore = await prisma.salePayment.count({ where: { saleId: sale.id } });

      await postReturn(sale.id, {
        items: [{ saleItemId, quantity: 4 }],
        refundMethod: "CASH",
      }).expect(201);

      const storedSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true, payments: true },
      });

      // The sale keeps its full historical value: revenue 20, returned 8,
      // net after returns 12 — derived, never by editing the sale.
      expect(storedSale.totalAmount.toNumber()).toBe(20);
      expect(storedSale.paidAmount.toNumber()).toBe(20);
      expect(storedSale.status).toBe("COMPLETED");
      // No refund was appended to the original sale's payment rows.
      expect(storedSale.payments.length).toBe(paymentsBefore);
      expect(storedSale.payments[0].amount.toNumber()).toBe(20);
      // The original line is untouched.
      expect(storedSale.items[0].quantity.toNumber()).toBe(10);
      expect(storedSale.items[0].lineTotal.toNumber()).toBe(20);
    });

    it("exposes the return and its refund for finance reporting", async () => {
      const sale = await sell([
        { productId: paracetamolId, unitId: boxUnitId, quantity: 5, unitPrice: 80 },
      ]);
      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "MOBILE_TRANSFER",
      }).expect(201);

      const list = await request(app)
        .get(`/api/v1/pos/returns?saleId=${sale.id}`)
        .set("Cookie", cookie)
        .expect(200);

      expect(list.body.data.length).toBe(1);
      expect(list.body.data[0].id).toBe(created.body.data.id);
      expect(list.body.summary.refundAmount).toBe(80);
      expect(list.body.data[0].refundMethod).toBe("MOBILE_TRANSFER");
      expect(list.body.data[0].sale.totalAmount).toBe(400);

      const detail = await request(app)
        .get(`/api/v1/pos/returns/${created.body.data.id}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(detail.body.data.saleId).toBe(sale.id);
      expect(detail.body.data.items[0].refundAmount).toBe(80);
    });

    it("writes an audit trail entry in the same transaction", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 3, unitPrice: 2 }]);
      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refundMethod: "CASH",
      }).expect(201);

      const audit = await prisma.auditTrail.findFirst({
        where: { entityId: created.body.data.id, description: "SALE_RETURN_CREATED" },
      });
      expect(audit).not.toBeNull();
      expect(audit!.userId).toBe(userId);
    });
  });

  // =========================================================================
  // Reliability
  // =========================================================================
  describe("reliability", () => {
    it("does not create a duplicate return, refund or stock movement on a retry", async () => {
      const before = await totalStockAt(ibuprofenId, mainLocationId);
      const sale = await sell([{ productId: ibuprofenId, unitId: tabletUnitId, quantity: 5, unitPrice: 1.5 }]);
      const saleItemId = sale.items[0].id;
      const stockAfterSale = await totalStockAt(ibuprofenId, mainLocationId);

      const key = `ret-idem-${Date.now()}-abc`;
      const body = {
        items: [{ saleItemId, quantity: 2 }],
        refundMethod: "CASH",
        idempotencyKey: key,
      };

      const first = await postReturn(sale.id, body).expect(201);
      // The cashier double-clicks: same request, same key.
      const second = await postReturn(sale.id, body).expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(1);
      expect(await prisma.saleReturnItem.count({ where: { saleItemId } })).toBe(1);
      // Stock moved once, not twice.
      expect(await totalStockAt(ibuprofenId, mainLocationId)).toBe(stockAfterSale + 2);
      expect(stockAfterSale + 2).toBe(before - 3);
      expect((await returnMovements()).filter((m) => m.referenceId === first.body.data.items[0].id).length).toBe(1);
    });

    it("never lets concurrent returns exceed the quantity sold", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 10, unitPrice: 2 }]);
      const saleItemId = sale.items[0].id;

      // Two cashiers try to return 7 and 5 of the same 10 units at once.
      const results = await Promise.all([
        postReturn(sale.id, { items: [{ saleItemId, quantity: 7 }], refundMethod: "CASH" }),
        postReturn(sale.id, { items: [{ saleItemId, quantity: 5 }], refundMethod: "CASH" }),
      ]);

      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 422);

      expect(created.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].body.error.code).toBe("RETURN_QUANTITY_EXCEEDS_SOLD");

      // 7 + 5 = 12 must never have been returned.
      const info = await returnInfo(sale.id).expect(200);
      expect(info.body.data.items[0].quantityReturned).toBe(7);
      expect(info.body.data.items[0].quantityReturnable).toBe(3);
      expect(info.body.data.totalRefunded).toBe(14);
    });

    it("rolls back everything when one item of a multi-item return fails", async () => {
      await seedStock(expiredBatchProductId, `RET-EXP-B-${Date.now()}`, 500);
      const sale = await sell([
        { productId: paracetamolId, unitId: tabletUnitId, quantity: 5, unitPrice: 2 },
        { productId: expiredBatchProductId, unitId: tabletUnitId, quantity: 5, unitPrice: 10 },
      ]);
      const [good, doomed] = sale.items;

      // Expire the second line's batch so restocking it is rejected.
      const doomedBatch = await prisma.saleItemBatch.findFirstOrThrow({
        where: { saleItemId: doomed.id },
      });
      await prisma.batch.update({
        where: { id: doomedBatch.batchId },
        data: { expiryDate: new Date("2020-01-01T00:00:00.000Z") },
      });

      const stockBefore = await totalStockAt(paracetamolId, mainLocationId);
      const movementsBefore = (await returnMovements()).length;

      const res = await postReturn(sale.id, {
        items: [
          { saleItemId: good.id, quantity: 5 },
          { saleItemId: doomed.id, quantity: 5 },
        ],
        refundMethod: "CASH",
      }).expect(409);

      expect(res.body.error.code).toBe("RETURN_BATCH_EXPIRED");
      // No return, no refund and no partial stock movement survived.
      expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
      expect(await prisma.saleReturnItem.count({ where: { saleItemId: good.id } })).toBe(0);
      expect(await totalStockAt(paracetamolId, mainLocationId)).toBe(stockBefore);
      expect((await returnMovements()).length).toBe(movementsBefore);
    });

    it("rolls back the whole return when the location cannot receive stock", async () => {
      const sale = await sell([{ productId: paracetamolId, unitId: tabletUnitId, quantity: 4, unitPrice: 2 }], {
        locationId: otherLocationId,
      });
      const stockBefore = await totalStockAt(paracetamolId, otherLocationId);

      await prisma.inventoryLocation.update({ where: { id: otherLocationId }, data: { isActive: false } });

      const res = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 4 }],
        refundMethod: "CASH",
      }).expect(409);
      expect(res.body.error.code).toBe("INACTIVE_LOCATION");

      expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
      expect(await totalStockAt(paracetamolId, otherLocationId)).toBe(stockBefore);

      await prisma.inventoryLocation.update({ where: { id: otherLocationId }, data: { isActive: true } });

      // A non-restockable return still refunds even in an inactive location.
      const created = await postReturn(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 4, restock: false }],
        refundMethod: "CASH",
      }).expect(201);
      expect(created.body.data.refundAmount).toBe(8);
    });
  });
});