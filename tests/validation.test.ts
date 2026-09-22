import { z } from "zod";
import { describe, expect, it } from "vitest";
import { validate } from "../src/middleware/validate.js";
import {
  supplierIdParamsSchema,
  supplierProductBatchQuerySchema,
  supplierProductListQuerySchema,
  supplierProductParamsSchema,
} from "../src/validators/purchasing/supplier-catalog.js";
import type { NextFunction, Request, Response } from "express";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    query: {},
    params: {},
    ...overrides,
  } as Request;
}

describe("validate middleware", () => {
  it("accepts valid body, query, and params", () => {
    const middleware = validate({
      body: z.object({ name: z.string().min(1) }),
      query: z.object({ page: z.coerce.number().int().positive() }),
      params: z.object({ id: z.string().uuid() }),
    });
    const req = mockReq({
      body: { name: "Aspirin" },
      query: { page: "2" },
      params: { id: "11111111-1111-4111-8111-111111111111" },
    });
    let nextCalled = false;
    middleware(req, {} as Response, ((err?: unknown) => {
      expect(err).toBeUndefined();
      nextCalled = true;
    }) as NextFunction);
    expect(nextCalled).toBe(true);
    expect(req.body).toEqual({ name: "Aspirin" });
  });

  it("rejects invalid input before business logic", () => {
    const middleware = validate({
      body: z.object({ email: z.string().email() }),
    });
    const req = mockReq({ body: { email: "not-an-email" } });
    let captured: unknown;
    middleware(req, {} as Response, ((err?: unknown) => {
      captured = err;
    }) as NextFunction);
    expect(captured).toBeInstanceOf(z.ZodError);
  });
});

describe("supplier catalog lookup schemas", () => {
  it("accepts the documented supplier-product and batch query params", () => {
    const list = supplierProductListQuerySchema.parse({
      page: "1",
      limit: "20",
      search: "amox",
      isActive: "false",
    });
    expect(list).toMatchObject({ page: 1, limit: 20, search: "amox", isActive: "false" });

    const batches = supplierProductBatchQuerySchema.parse({
      locationId: "11111111-1111-4111-8111-111111111111",
      inStock: "false",
      excludeExpired: "false",
    });
    expect(batches).toMatchObject({ inStock: "false", excludeExpired: "false" });
  });

  it("rejects malformed ids, non-boolean flags and out-of-range pagination", () => {
    expect(supplierIdParamsSchema.safeParse({ supplierId: "not-a-uuid" }).success).toBe(false);
    expect(supplierProductParamsSchema.safeParse({
      supplierId: "11111111-1111-4111-8111-111111111111",
      productId: "nope",
    }).success).toBe(false);
    // `true`/`false` are the only accepted spellings for the flags.
    expect(supplierProductListQuerySchema.safeParse({ isActive: "yes" }).success).toBe(false);
    expect(supplierProductBatchQuerySchema.safeParse({ inStock: "1" }).success).toBe(false);
    expect(
      supplierProductBatchQuerySchema.safeParse({ locationId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(supplierProductListQuerySchema.safeParse({ limit: "1000" }).success).toBe(false);
  });
});
