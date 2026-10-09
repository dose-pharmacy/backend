import { Prisma, PurchaseOrderStatus, PurchaseRequirementStatus } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import app from "../src/app.js";
import {
  requirementLinesQuerySchema,
  requirementLineParamsSchema,
} from "../src/validators/purchasing/requirement.js";
import {
  computeLineQuantities,
  mapRequirementLine,
  requirementService,
} from "../src/services/purchasing/requirement.service.js";
import { prisma } from "../src/database/prisma.js";

// Mock prisma for service tests so tests run reliably without remote DB connection
vi.mock("../src/database/prisma.js", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      purchaseRequirement: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        groupBy: vi.fn(),
      },
      purchaseRequirementLine: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
      },
    },
  };
});

describe("Purchase Requirement Lines API & Business Rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Validator Tests
  // ---------------------------------------------------------------------------
  describe("Validators: requirementLinesQuerySchema & requirementLineParamsSchema", () => {
    it("accepts empty query and applies defaults", () => {
      const parsed = requirementLinesQuerySchema.parse({});
      expect(parsed.page).toBeUndefined();
      expect(parsed.limit).toBeUndefined();
      expect(parsed.status).toBeUndefined();
      expect(parsed.statuses).toBeUndefined();
      expect(parsed.search).toBeUndefined();
    });

    it("accepts valid explicit statuses independently", () => {
      const statuses: PurchaseRequirementStatus[] = [
        "OPEN",
        "PARTIALLY_FULFILLED",
        "FULFILLED",
        "CLOSED",
      ];
      for (const s of statuses) {
        const parsed = requirementLinesQuerySchema.parse({ status: s });
        expect(parsed.status).toBe(s);
      }
    });

    it("rejects invalid status", () => {
      expect(() => requirementLinesQuerySchema.parse({ status: "INVALID_STATUS" })).toThrow();
    });

    it("preprocesses comma-separated statuses into array", () => {
      const parsed = requirementLinesQuerySchema.parse({
        statuses: "OPEN,PARTIALLY_FULFILLED",
      });
      expect(parsed.statuses).toEqual(["OPEN", "PARTIALLY_FULFILLED"]);
    });

    it("rejects invalid status in statuses list", () => {
      expect(() =>
        requirementLinesQuerySchema.parse({ statuses: "OPEN,UNKNOWN" }),
      ).toThrow();
    });

    it("validates pagination bounds", () => {
      expect(() => requirementLinesQuerySchema.parse({ page: 0 })).toThrow();
      expect(() => requirementLinesQuerySchema.parse({ page: -1 })).toThrow();
      expect(() => requirementLinesQuerySchema.parse({ limit: 0 })).toThrow();
      expect(() => requirementLinesQuerySchema.parse({ limit: 101 })).toThrow();

      const valid = requirementLinesQuerySchema.parse({ page: 2, limit: 50 });
      expect(valid.page).toBe(2);
      expect(valid.limit).toBe(50);
    });

    it("validates sortBy allowlist", () => {
      const allowed = ["createdAt", "updatedAt", "quantityNeeded", "requiredQuantity", "requiredBy"];
      for (const field of allowed) {
        const parsed = requirementLinesQuerySchema.parse({ sortBy: field, sortOrder: "asc" });
        expect(parsed.sortBy).toBe(field);
        expect(parsed.sortOrder).toBe("asc");
      }
      expect(() => requirementLinesQuerySchema.parse({ sortBy: "unknownField" })).toThrow();
    });

    it("validates UUID for lineId path param", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      expect(requirementLineParamsSchema.parse({ lineId: validUuid })).toEqual({
        lineId: validUuid,
      });
      expect(() => requirementLineParamsSchema.parse({ lineId: "not-a-uuid" })).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. HTTP Routing & Authorization Tests
  // ---------------------------------------------------------------------------
  describe("HTTP Routes & Authentication Guards", () => {
    it("guards GET /api/v1/purchasing/requirement-lines behind authentication (401)", async () => {
      const res = await request(app).get("/api/v1/purchasing/requirement-lines");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("guards GET /api/v1/purchasing/requirement-lines/:lineId behind authentication (401)", async () => {
      const res = await request(app).get(
        "/api/v1/purchasing/requirement-lines/123e4567-e89b-12d3-a456-426614174000",
      );
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("supports /api/v1/purchase alias for requirement-lines (401 when unauthenticated)", async () => {
      const res = await request(app).get("/api/v1/purchase/requirement-lines");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("supports /api/v1/purchase alias for requirement-lines/:lineId (401 when unauthenticated)", async () => {
      const res = await request(app).get(
        "/api/v1/purchase/requirement-lines/123e4567-e89b-12d3-a456-426614174000",
      );
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("supports /api/v1/purchasing/requirements/lines/:lineId alias (401 when unauthenticated)", async () => {
      const res = await request(app).get(
        "/api/v1/purchasing/requirements/lines/123e4567-e89b-12d3-a456-426614174000",
      );
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Purchasing Business Rules & Quantity Calculations
  // ---------------------------------------------------------------------------
  describe("Purchasing Business Rules & Quantity Calculations", () => {
    function createMockLineRow(overrides: {
      quantityNeeded: number;
      quantityNeededBase?: number;
      quantityDelivered?: number;
      status?: PurchaseRequirementStatus;
      allocations?: Array<{
        quantityAllocated: number;
        poStatus: PurchaseOrderStatus;
        quantityOrdered: number;
        quantityReceived: number;
        quantityShort?: number;
      }>;
    }) {
      const needed = new Prisma.Decimal(overrides.quantityNeeded);
      const base = new Prisma.Decimal(overrides.quantityNeededBase ?? overrides.quantityNeeded);
      const delivered = new Prisma.Decimal(overrides.quantityDelivered ?? 0);

      const allocations = (overrides.allocations ?? []).map((a, i) => ({
        id: `alloc-${i}`,
        quantityAllocated: new Prisma.Decimal(a.quantityAllocated),
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        purchaseOrderItem: {
          id: `item-${i}`,
          purchaseOrderId: `po-${i}`,
          quantityOrdered: new Prisma.Decimal(a.quantityOrdered),
          quantityReceived: new Prisma.Decimal(a.quantityReceived),
          quantityShort: new Prisma.Decimal(a.quantityShort ?? 0),
          unitCost: new Prisma.Decimal(10),
          purchaseOrder: {
            id: `po-${i}`,
            status: a.poStatus,
            poNumber: `PO-${i}`,
            supplier: { id: "supp-1", name: "Supplier 1" },
            orderDate: new Date("2026-10-01"),
            expectedDeliveryDate: null,
          },
        },
      }));

      return {
        id: "line-1",
        requirementId: "req-1",
        productId: "prod-1",
        product: { id: "prod-1", name: "Amoxicillin 500mg", sku: "AMOX-500", brand: "Generic" },
        unitId: "unit-1",
        unit: { id: "unit-1", name: "Tablet", symbol: "TAB" },
        quantityNeeded: needed,
        quantityNeededBase: base,
        quantityDelivered: delivered,
        reasonCode: "LOW_STOCK",
        status: overrides.status ?? PurchaseRequirementStatus.OPEN,
        notes: "Restock",
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        allocations,
      };
    }

    it("calculates initial OPEN state when no purchase orders exist", () => {
      const line = createMockLineRow({ quantityNeeded: 100 });
      const q = computeLineQuantities(line);

      expect(q.required).toBe(100);
      expect(q.orderedActive).toBe(0);
      expect(q.delivered).toBe(0);
      expect(q.quantityToOrder).toBe(100);
      expect(q.quantityAwaitingDelivery).toBe(0);
      expect(q.activeOrderCount).toBe(0);
      expect(q.status).toBe("OPEN");
    });

    it("calculates PARTIALLY_FULFILLED state when partially ordered", () => {
      const line = createMockLineRow({
        quantityNeeded: 100,
        allocations: [
          {
            quantityAllocated: 40,
            poStatus: PurchaseOrderStatus.AWAITING_DELIVERY,
            quantityOrdered: 40,
            quantityReceived: 0,
          },
        ],
      });
      const q = computeLineQuantities(line);

      expect(q.required).toBe(100);
      expect(q.orderedActive).toBe(40);
      expect(q.delivered).toBe(0);
      expect(q.quantityToOrder).toBe(60); // 100 - 40
      expect(q.quantityAwaitingDelivery).toBe(40);
      expect(q.activeOrderCount).toBe(1);
      expect(q.status).toBe("PARTIALLY_FULFILLED");
    });

    it("calculates PARTIALLY_FULFILLED state for partial order and partial receipt (40 target, 20 ordered, 15 received)", () => {
      const line = createMockLineRow({
        quantityNeeded: 40,
        quantityDelivered: 15,
        allocations: [
          {
            quantityAllocated: 20,
            poStatus: PurchaseOrderStatus.AWAITING_DELIVERY,
            quantityOrdered: 20,
            quantityReceived: 15,
          },
        ],
      });
      const q = computeLineQuantities(line);

      expect(q.required).toBe(40);
      expect(q.delivered).toBe(15);
      expect(q.orderedActive).toBe(20);
      // remainingToOrder: 40 - 15 - (20 - 15) = 20
      expect(q.quantityToOrder).toBe(20);
      // remainingToReceive: 20 ordered - 15 delivered = 5
      expect(q.quantityAwaitingDelivery).toBe(5);
      expect(q.activeOrderCount).toBe(1);
      expect(q.status).toBe("PARTIALLY_FULFILLED");
    });

    it("calculates FULFILLED state when quantityDelivered >= required", () => {
      const line = createMockLineRow({
        quantityNeeded: 50,
        quantityDelivered: 50,
        allocations: [
          {
            quantityAllocated: 50,
            poStatus: PurchaseOrderStatus.RECEIVED,
            quantityOrdered: 50,
            quantityReceived: 50,
          },
        ],
      });
      const q = computeLineQuantities(line);

      expect(q.required).toBe(50);
      expect(q.delivered).toBe(50);
      expect(q.orderedActive).toBe(50);
      expect(q.quantityToOrder).toBe(0);
      expect(q.quantityAwaitingDelivery).toBe(0);
      expect(q.status).toBe("FULFILLED");
    });

    it("excludes CANCELLED purchase orders from orderedQuantity and activeOrderCount", () => {
      const line = createMockLineRow({
        quantityNeeded: 100,
        allocations: [
          {
            quantityAllocated: 50,
            poStatus: PurchaseOrderStatus.CANCELLED,
            quantityOrdered: 50,
            quantityReceived: 0,
          },
          {
            quantityAllocated: 30,
            poStatus: PurchaseOrderStatus.AWAITING_DELIVERY,
            quantityOrdered: 30,
            quantityReceived: 0,
          },
        ],
      });
      const q = computeLineQuantities(line);

      // Cancelled order of 50 is ignored; only active 30 counts
      expect(q.orderedActive).toBe(30);
      expect(q.quantityToOrder).toBe(70);
      expect(q.quantityAwaitingDelivery).toBe(30);
      expect(q.activeOrderCount).toBe(1);
      expect(q.status).toBe("PARTIALLY_FULFILLED");
    });

    it("frees quantity back to remainingToOrder when shortage is accepted", () => {
      const line = createMockLineRow({
        quantityNeeded: 100,
        allocations: [
          {
            quantityAllocated: 60,
            poStatus: PurchaseOrderStatus.AWAITING_DELIVERY,
            quantityOrdered: 60,
            quantityReceived: 40,
            quantityShort: 20, // 20 shortfall accepted
          },
        ],
      });
      const q = computeLineQuantities(line);

      // Effective active ordered = received (40) + max(0, 60 - 40 - 20) = 40.
      expect(q.orderedActive).toBe(40);
      expect(q.quantityToOrder).toBe(60); // 100 - 40
      expect(q.quantityAwaitingDelivery).toBe(40);
    });

    it("preserves CLOSED status if line was marked CLOSED", () => {
      const line = createMockLineRow({
        quantityNeeded: 100,
        status: PurchaseRequirementStatus.CLOSED,
      });
      const q = computeLineQuantities(line);

      expect(q.status).toBe("CLOSED");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Dedicated List Endpoint Service Logic (Filtering, Search, Pagination)
  // ---------------------------------------------------------------------------
  describe("requirementService.listRequirementLines", () => {
    const mockPrisma = prisma as unknown as {
      $transaction: ReturnType<typeof vi.fn>;
      purchaseRequirementLine: {
        findMany: ReturnType<typeof vi.fn>;
        count: ReturnType<typeof vi.fn>;
      };
    };

    it("applies default status filter (OPEN and PARTIALLY_FULFILLED, excluding parent CLOSED) when no status filter is supplied", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      await requirementService.listRequirementLines({});

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("filters by explicit status OPEN", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({
        status: PurchaseRequirementStatus.OPEN,
      });

      expect(result.items).toEqual([]);
      expect(result.meta.page).toBe(1);
    });

    it("filters by explicit status PARTIALLY_FULFILLED", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({
        status: PurchaseRequirementStatus.PARTIALLY_FULFILLED,
      });

      expect(result.items).toEqual([]);
    });

    it("filters by explicit status FULFILLED", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({
        status: PurchaseRequirementStatus.FULFILLED,
      });

      expect(result.items).toEqual([]);
    });

    it("filters by explicit status CLOSED (includes closed lines and lines from closed requirements)", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({
        status: PurchaseRequirementStatus.CLOSED,
      });

      expect(result.items).toEqual([]);
    });

    it("supports multi-status filter (statuses: ['OPEN', 'PARTIALLY_FULFILLED'])", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({
        statuses: [PurchaseRequirementStatus.OPEN, PurchaseRequirementStatus.PARTIALLY_FULFILLED],
      });

      expect(result.items).toEqual([]);
    });

    it("supports search parameter across product name, SKU, and requirement reference", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      await requirementService.listRequirementLines({
        search: "Amox",
      });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("combines search with status filter", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      await requirementService.listRequirementLines({
        search: "PR-1234",
        status: PurchaseRequirementStatus.OPEN,
      });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("calculates pagination metadata correctly", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 45, 20, 15, 5, 5]);

      const result = await requirementService.listRequirementLines({
        page: 2,
        limit: 10,
      });

      expect(result.meta.page).toBe(2);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.total).toBe(45);
      expect(result.meta.totalPages).toBe(5);
      expect(result.summary.open).toBe(20);
      expect(result.summary.partiallyFulfilled).toBe(15);
      expect(result.summary.fulfilled).toBe(5);
      expect(result.summary.closed).toBe(5);
    });

    it("handles zero total matching lines cleanly", async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0, 0, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({
        search: "nonexistent",
      });

      expect(result.items).toHaveLength(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Requirement Line Detail Endpoint
  // ---------------------------------------------------------------------------
  describe("requirementService.getRequirementLineDetail", () => {
    const mockPrisma = prisma as unknown as {
      purchaseRequirementLine: {
        findUnique: ReturnType<typeof vi.fn>;
      };
    };

    it("returns 404 when requirement line does not exist", async () => {
      mockPrisma.purchaseRequirementLine.findUnique.mockResolvedValue(null);

      await expect(
        requirementService.getRequirementLineDetail("123e4567-e89b-12d3-a456-426614174000"),
      ).rejects.toThrow("Requirement line not found");
    });

    it("returns detailed line data with linked purchase order history", async () => {
      const mockLine = {
        id: "line-123",
        requirementId: "req-456",
        productId: "prod-789",
        product: { id: "prod-789", name: "Paracetamol 500mg", sku: "PARA-500", brand: "Acme" },
        unitId: "unit-1",
        unit: { id: "unit-1", name: "Box", symbol: "BOX" },
        quantityNeeded: new Prisma.Decimal(50),
        quantityNeededBase: new Prisma.Decimal(500),
        quantityDelivered: new Prisma.Decimal(20),
        reasonCode: "REORDER_ALERT",
        status: PurchaseRequirementStatus.PARTIALLY_FULFILLED,
        notes: "Urgent order",
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-02"),
        requirement: {
          id: "req-456",
          reference: "PR-202610-001",
          status: PurchaseRequirementStatus.OPEN,
          requiredBy: new Date("2026-10-15"),
          notes: "Header notes",
          createdAt: new Date("2026-10-01"),
          updatedAt: new Date("2026-10-02"),
          createdBy: { id: "user-1", name: "Purchasing Manager" },
        },
        allocations: [
          {
            id: "alloc-1",
            quantityAllocated: new Prisma.Decimal(30),
            createdAt: new Date("2026-10-03"),
            updatedAt: new Date("2026-10-03"),
            purchaseOrderItem: {
              id: "poi-1",
              purchaseOrderId: "po-1",
              quantityOrdered: new Prisma.Decimal(30),
              quantityReceived: new Prisma.Decimal(20),
              quantityShort: new Prisma.Decimal(0),
              unitCost: new Prisma.Decimal(12.5),
              purchaseOrder: {
                id: "po-1",
                status: PurchaseOrderStatus.AWAITING_DELIVERY,
                poNumber: "PO-202610-101",
                supplier: { id: "supp-1", name: "PharmaCorp" },
                orderDate: new Date("2026-10-03"),
                expectedDeliveryDate: new Date("2026-10-10"),
              },
            },
          },
        ],
      };

      mockPrisma.purchaseRequirementLine.findUnique.mockResolvedValue(mockLine);

      const detail = await requirementService.getRequirementLineDetail("line-123");

      expect(detail.id).toBe("line-123");
      expect(detail.requirementId).toBe("req-456");
      expect(detail.requirementReference).toBe("PR-202610-001");
      expect(detail.productName).toBe("Paracetamol 500mg");
      expect(detail.productSku).toBe("PARA-500");
      expect(detail.unitName).toBe("Box");
      expect(detail.unitSymbol).toBe("BOX");
      expect(detail.requiredQuantity).toBe(50);
      expect(detail.quantityDelivered).toBe(20);
      expect(detail.requirement.reference).toBe("PR-202610-001");
      expect(detail.requirement.createdBy?.name).toBe("Purchasing Manager");

      expect(detail.purchaseOrders).toHaveLength(1);
      const poHistory = detail.purchaseOrders[0]!;
      expect(poHistory.purchaseOrderId).toBe("po-1");
      expect(poHistory.purchaseOrderNumber).toBe("PO-202610-101");
      expect(poHistory.supplier?.name).toBe("PharmaCorp");
      expect(poHistory.purchaseOrderStatus).toBe(PurchaseOrderStatus.AWAITING_DELIVERY);
      expect(poHistory.quantityAllocated).toBe(30);
      expect(poHistory.quantityOrdered).toBe(30);
      expect(poHistory.quantityReceived).toBe(20);
      expect(poHistory.quantityShort).toBe(0);
      expect(poHistory.outstandingDeliveryQuantity).toBe(10); // 30 - 20
      expect(poHistory.unitCost).toBe(12.5);
      expect(poHistory.active).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Backward Compatibility of Legacy Endpoints & Quantities
  // ---------------------------------------------------------------------------
  describe("Backward Compatibility", () => {
    it("preserves legacy aliases in mapRequirementLine", () => {
      const line = {
        id: "line-1",
        requirementId: "req-1",
        productId: "prod-1",
        product: { id: "prod-1", name: "Paracetamol", sku: "PARA", brand: null },
        unitId: "unit-1",
        unit: { id: "unit-1", name: "Tablet", symbol: "TAB" },
        quantityNeeded: new Prisma.Decimal(100),
        quantityNeededBase: new Prisma.Decimal(100),
        quantityDelivered: new Prisma.Decimal(25),
        reasonCode: "MANUAL",
        status: PurchaseRequirementStatus.OPEN,
        notes: null,
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        allocations: [],
      };

      const mapped = mapRequirementLine(line);

      expect(mapped.requiredQuantity).toBe(100);
      // Legacy aliases
      expect(mapped.quantityNeeded).toBe(100);
      expect(mapped.quantityOrdered).toBe(0);
      expect(mapped.orderedQuantity).toBe(0);
      expect(mapped.quantityRemaining).toBe(75); // 100 - 25
      expect(mapped.remainingQuantity).toBe(75);
      expect(mapped.remainingToOrder).toBe(75);
      expect(mapped.quantityDelivered).toBe(25);
      expect(mapped.remainingToReceive).toBe(0);
    });

    it("verifies parent requirement list requirementService.list returns parent rows with nested lines", async () => {
      const mockPrisma = prisma as unknown as {
        $transaction: ReturnType<typeof vi.fn>;
      };

      const mockParent = {
        id: "req-1",
        reference: "PR-202610-001",
        status: PurchaseRequirementStatus.OPEN,
        requiredBy: null,
        notes: null,
        createdById: "user-1",
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        lines: [
          {
            id: "line-1",
            requirementId: "req-1",
            productId: "prod-1",
            product: { id: "prod-1", name: "Paracetamol", sku: "PARA", brand: null },
            unitId: "unit-1",
            unit: { id: "unit-1", name: "Tablet", symbol: "TAB" },
            quantityNeeded: new Prisma.Decimal(50),
            quantityNeededBase: new Prisma.Decimal(50),
            quantityDelivered: new Prisma.Decimal(0),
            reasonCode: "LOW_STOCK",
            status: PurchaseRequirementStatus.OPEN,
            notes: null,
            createdAt: new Date("2026-10-01"),
            updatedAt: new Date("2026-10-01"),
            allocations: [],
          },
        ],
        createdBy: { id: "user-1", name: "Admin" },
      };

      mockPrisma.$transaction.mockResolvedValue([[mockParent], 1, [{ status: "OPEN", _count: 1 }]]);

      const result = await requirementService.list({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.id).toBe("req-1");
      expect(result.items[0]!.reference).toBe("PR-202610-001");
      expect(result.items[0]!.lines).toHaveLength(1);
      expect(result.items[0]!.lines[0]!.requiredQuantity).toBe(50);
      expect(result.summary.open).toBe(1);
    });

    it("correctly handles multiple lines under one parent requirement in the flat lines endpoint", async () => {
      const mockPrisma = prisma as unknown as {
        $transaction: ReturnType<typeof vi.fn>;
      };

      const lineA = {
        id: "line-A",
        requirementId: "req-1",
        productId: "prod-1",
        product: { id: "prod-1", name: "Paracetamol 500mg", sku: "PARA-500", brand: null },
        unitId: null,
        unit: null,
        quantityNeeded: new Prisma.Decimal(100),
        quantityNeededBase: new Prisma.Decimal(100),
        quantityDelivered: new Prisma.Decimal(0),
        reasonCode: "LOW_STOCK",
        status: PurchaseRequirementStatus.OPEN,
        notes: null,
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        allocations: [],
        requirement: {
          id: "req-1",
          reference: "PR-202610-001",
          status: PurchaseRequirementStatus.OPEN,
          requiredBy: null,
          notes: null,
          createdAt: new Date("2026-10-01"),
          updatedAt: new Date("2026-10-01"),
          createdBy: { id: "user-1", name: "Admin" },
        },
      };

      const lineB = {
        id: "line-B",
        requirementId: "req-1",
        productId: "prod-2",
        product: { id: "prod-2", name: "Amoxicillin 500mg", sku: "AMOX-500", brand: null },
        unitId: null,
        unit: null,
        quantityNeeded: new Prisma.Decimal(50),
        quantityNeededBase: new Prisma.Decimal(50),
        quantityDelivered: new Prisma.Decimal(0),
        reasonCode: "REORDER_ALERT",
        status: PurchaseRequirementStatus.OPEN,
        notes: null,
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        allocations: [],
        requirement: {
          id: "req-1",
          reference: "PR-202610-001",
          status: PurchaseRequirementStatus.OPEN,
          requiredBy: null,
          notes: null,
          createdAt: new Date("2026-10-01"),
          updatedAt: new Date("2026-10-01"),
          createdBy: { id: "user-1", name: "Admin" },
        },
      };

      mockPrisma.$transaction.mockResolvedValue([[lineA, lineB], 2, 2, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({});

      // Flat output: each line is its own row sharing the same parent requirementReference
      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.id).toBe("line-A");
      expect(result.items[0]!.productSku).toBe("PARA-500");
      expect(result.items[0]!.requirementReference).toBe("PR-202610-001");
      expect(result.items[1]!.id).toBe("line-B");
      expect(result.items[1]!.productSku).toBe("AMOX-500");
      expect(result.items[1]!.requirementReference).toBe("PR-202610-001");
    });

    it("correctly handles the same product appearing in different requirements as independent rows", async () => {
      const mockPrisma = prisma as unknown as {
        $transaction: ReturnType<typeof vi.fn>;
      };

      const line1 = {
        id: "line-req1-prod1",
        requirementId: "req-1",
        productId: "prod-1",
        product: { id: "prod-1", name: "Paracetamol 500mg", sku: "PARA-500", brand: null },
        unitId: null,
        unit: null,
        quantityNeeded: new Prisma.Decimal(40),
        quantityNeededBase: new Prisma.Decimal(40),
        quantityDelivered: new Prisma.Decimal(0),
        reasonCode: "LOW_STOCK",
        status: PurchaseRequirementStatus.OPEN,
        notes: null,
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
        allocations: [],
        requirement: {
          id: "req-1",
          reference: "PR-001",
          status: PurchaseRequirementStatus.OPEN,
          requiredBy: null,
          notes: null,
          createdAt: new Date("2026-10-01"),
          updatedAt: new Date("2026-10-01"),
          createdBy: { id: "user-1", name: "Admin" },
        },
      };

      const line2 = {
        id: "line-req2-prod1",
        requirementId: "req-2",
        productId: "prod-1",
        product: { id: "prod-1", name: "Paracetamol 500mg", sku: "PARA-500", brand: null },
        unitId: null,
        unit: null,
        quantityNeeded: new Prisma.Decimal(60),
        quantityNeededBase: new Prisma.Decimal(60),
        quantityDelivered: new Prisma.Decimal(0),
        reasonCode: "MANUAL",
        status: PurchaseRequirementStatus.OPEN,
        notes: null,
        createdAt: new Date("2026-10-02"),
        updatedAt: new Date("2026-10-02"),
        allocations: [],
        requirement: {
          id: "req-2",
          reference: "PR-002",
          status: PurchaseRequirementStatus.OPEN,
          requiredBy: null,
          notes: null,
          createdAt: new Date("2026-10-02"),
          updatedAt: new Date("2026-10-02"),
          createdBy: { id: "user-1", name: "Admin" },
        },
      };

      mockPrisma.$transaction.mockResolvedValue([[line1, line2], 2, 2, 0, 0, 0]);

      const result = await requirementService.listRequirementLines({ search: "PARA-500" });

      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.id).toBe("line-req1-prod1");
      expect(result.items[0]!.requirementReference).toBe("PR-001");
      expect(result.items[0]!.requiredQuantity).toBe(40);
      expect(result.items[1]!.id).toBe("line-req2-prod1");
      expect(result.items[1]!.requirementReference).toBe("PR-002");
      expect(result.items[1]!.requiredQuantity).toBe(60);
    });
  });
});

