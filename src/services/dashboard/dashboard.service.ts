// ── Dashboard Service ──────────────────────────────────────────────────────
// Provides three lightweight, purpose-built queries for the operational
// dashboard.  These intentionally reuse the business rules already
// established in the inventory dashboard service, POS sale service, and
// purchasing services — they do NOT introduce a second definition of what
// "today's sales" or "low stock" means.
//
// Design notes:
//  · All independent queries in each endpoint run in parallel (Promise.all).
//  · Database does every aggregation — nothing is loaded into Node memory.
//  · "Today" always means UTC midnight onward (matches existing convention).
//  · stockValue uses ProductUnit.purchasePrice on the base unit — the same
//    formula as the slow-moving report and the rest of the codebase.
//  · Slow-moving count reads the persisted isFlagged boolean only; it never
//    triggers evaluateSlowMoving().
//  · Partially-received POs: a PO that is still open to receive
//    (AWAITING_DELIVERY) and has at least one item with goods
//    received (quantityReceived > 0) that is not yet fully accounted for
//    (received + accepted short < ordered).

import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { startOfTodayUtc, addUtcDays } from "../../utils/date-time.js";

// ── Shared constants ──────────────────────────────────────────────────────

/** Expiry warning window used throughout the codebase. */
const EXPIRY_SOON_DAYS = 30;

// ── Response Types ────────────────────────────────────────────────────────

export type DashboardSummary = {
  sales: {
    today: number;
    transactions: number;
    averageTransaction: number;
  };
  inventory: {
    stockValue: number;
    lowStockCount: number;
    outOfStockCount: number;
    expiringSoonCount: number;
    expiredCount: number;
  };
  purchasing: {
    openRequirements: number;
    awaitingDelivery: number;
    partiallyReceived: number;
    outstandingInvoices: number;
  };
  slowMoving: {
    flaggedCount: number;
  };
};

export type LowStockItem = {
  productId: string;
  productName: string;
  sku: string;
  availableStock: number;
  reorderPoint: number;
  baseUnitName: string;
};

export type ExpiringSoonItem = {
  batchId: string;
  productId: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  remainingQuantity: number;
  baseUnitName: string;
};

export type AwaitingDeliveryItem = {
  purchaseOrderId: string;
  poNumber: string;
  supplierName: string;
  expectedDeliveryDate: string | null;
};

export type OutstandingInvoiceItem = {
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  outstandingBalance: number;
  dueDate: string | null;
};

export type DashboardAttention = {
  lowStock: LowStockItem[];
  expiringSoon: ExpiringSoonItem[];
  awaitingDelivery: AwaitingDeliveryItem[];
  outstandingInvoices: OutstandingInvoiceItem[];
};

export type ActivityType =
  | "SALE_COMPLETED"
  | "GOODS_RECEIVED"
  | "PURCHASE_ORDER_CREATED";

export type ActivityItem = {
  type: ActivityType;
  reference: string;
  description: string;
  createdAt: string;
};

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Low-stock count: active products whose total stock is > 0 but <= the
 * effective reorder threshold (reorderPoint when set, else minimumStock).
 * Identical logic to inventory/dashboard.service.ts; extracted here to avoid
 * creating a second inconsistent definition.
 */
async function countLowStock(): Promise<number> {
  const rows = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT s."productId")::bigint AS count
    FROM "inventory_stock" s
    JOIN "product" p ON p.id = s."productId"
    WHERE p."isActive" = true
    GROUP BY p.id, p."minimumStock", p."reorderPoint"
    HAVING SUM(s.quantity) > 0 AND SUM(s.quantity) <= COALESCE(p."reorderPoint", p."minimumStock")
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Out-of-stock count: active products with no stock rows or zero total.
 * Same logic as inventory/dashboard.service.ts.
 */
async function countOutOfStock(): Promise<number> {
  const rows = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT p.id)::bigint AS count
    FROM "product" p
    WHERE p."isActive" = true
    AND NOT EXISTS (
      SELECT 1 FROM "inventory_stock" s
      WHERE s."productId" = p.id AND s.quantity > 0
    )
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Total stock value: SUM(inventory_stock.quantity × base_unit.purchase_price).
 * ProductUnit.purchasePrice on the base unit is the authoritative reference
 * cost throughout the codebase (used by slow-moving report, financial report).
 */
async function calcStockValue(): Promise<number> {
  const rows = await prisma.$queryRaw<[{ total: Prisma.Decimal | null }]>`
    SELECT COALESCE(SUM(s.quantity * pu."purchasePrice"), 0) AS total
    FROM "inventory_stock" s
    JOIN "product_unit" pu
      ON pu."productId" = s."productId"
     AND pu."isBaseUnit" = true
    WHERE pu."purchasePrice" IS NOT NULL
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Partially-received POs: POs still in a pre-close state that have at
 * least one item where quantityReceived > 0 (some goods arrived) but
 * quantityReceived < quantityOrdered (not fully received yet).
 */
async function countPartiallyReceived(): Promise<number> {
  const rows = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT po.id)::bigint AS count
    FROM "purchase_order" po
    WHERE po.status IN ('AWAITING_DELIVERY')
    AND EXISTS (
      SELECT 1 FROM "purchase_order_item" poi
      WHERE poi."purchaseOrderId" = po.id
        AND poi."quantityReceived" > 0
        AND poi."quantityReceived" + poi."quantityShort" < poi."quantityOrdered"
    )
  `;
  return Number(rows[0]?.count ?? 0);
}

// ── Public service functions ──────────────────────────────────────────────

/**
 * GET /dashboard/summary
 *
 * Runs all independent sub-queries in parallel.  Returns a flat set of
 * operational counters — never a full dataset.
 */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const today = startOfTodayUtc();
  const expirySoonCutoff = addUtcDays(today, EXPIRY_SOON_DAYS);

  const [
    salesAgg,
    salesCount,
    stockValue,
    lowStockCount,
    outOfStockCount,
    expiringSoonCount,
    expiredCount,
    openRequirements,
    awaitingDelivery,
    partiallyReceived,
    outstandingInvoices,
    slowMovingFlagged,
  ] = await Promise.all([
    // Today's completed sales revenue
    prisma.sale.aggregate({
      _sum: { totalAmount: true },
      where: { status: "COMPLETED", createdAt: { gte: today } },
    }),
    // Today's completed transaction count
    prisma.sale.count({
      where: { status: "COMPLETED", createdAt: { gte: today } },
    }),
    // Stock value via raw SQL (joins base unit purchase price)
    calcStockValue(),
    // Low-stock count
    countLowStock(),
    // Out-of-stock count
    countOutOfStock(),
    // Batches expiring within 30 days with remaining stock
    prisma.batch.count({
      where: {
        expiryDate: { gte: today, lte: expirySoonCutoff },
        stock: { some: { quantity: { gt: 0 } } },
      },
    }),
    // Expired batches with remaining stock
    prisma.batch.count({
      where: {
        expiryDate: { lt: today },
        stock: { some: { quantity: { gt: 0 } } },
      },
    }),
    // Open purchase requirements
    prisma.purchaseRequirement.count({ where: { status: "OPEN" } }),
    // POs awaiting delivery
    prisma.purchaseOrder.count({ where: { status: "AWAITING_DELIVERY" } }),
    // POs with partial receiving
    countPartiallyReceived(),
    // Unpaid supplier invoices
    prisma.supplierInvoice.count({
      where: { status: { in: ["OPEN", "PARTIALLY_PAID"] } },
    }),
    // Slow-moving: persisted isFlagged only — never triggers evaluation
    prisma.slowMovingConfiguration.count({ where: { isFlagged: true } }),
  ]);

  const todayRevenue = salesAgg._sum.totalAmount?.toNumber() ?? 0;
  const transactions = salesCount;
  const averageTransaction =
    transactions > 0
      ? Math.round((todayRevenue / transactions) * 100) / 100
      : 0;

  return {
    sales: {
      today: Math.round(todayRevenue * 100) / 100,
      transactions,
      averageTransaction,
    },
    inventory: {
      stockValue: Math.round(stockValue * 100) / 100,
      lowStockCount,
      outOfStockCount,
      expiringSoonCount,
      expiredCount,
    },
    purchasing: {
      openRequirements,
      awaitingDelivery,
      partiallyReceived,
      outstandingInvoices,
    },
    slowMoving: {
      flaggedCount: slowMovingFlagged,
    },
  };
}

/**
 * GET /dashboard/attention
 *
 * Returns small actionable lists (≤5 per category) so the user can see
 * what needs immediate action without navigating to each module.
 */
export async function getDashboardAttention(): Promise<DashboardAttention> {
  const today = startOfTodayUtc();
  const expirySoonCutoff = addUtcDays(today, EXPIRY_SOON_DAYS);

  const [lowStockRows, expiringSoonRows, awaitingDeliveryRows, invoiceRows] =
    await Promise.all([
      // ── Low stock: up to 5 products closest to running out ──
      prisma.$queryRaw<
        Array<{
          productId: string;
          productName: string;
          sku: string;
          availableStock: number;
          reorderPoint: number;
          baseUnitName: string;
        }>
      >`
        SELECT
          p.id                    AS "productId",
          p.name                  AS "productName",
          p.sku                   AS "sku",
          SUM(s.quantity)::float  AS "availableStock",
          COALESCE(p."reorderPoint", p."minimumStock")::float AS "reorderPoint",
          bu."name"               AS "baseUnitName"
        FROM "inventory_stock" s
        JOIN "product" p ON p.id = s."productId"
        LEFT JOIN LATERAL (
          SELECT unit."name"
          FROM "product_unit" pu
          JOIN "unit" unit ON unit.id = pu."unitId"
          WHERE pu."productId" = p.id AND pu."isBaseUnit" = true
          LIMIT 1
        ) bu ON true
        WHERE p."isActive" = true
        GROUP BY p.id, p.name, p.sku, p."minimumStock", p."reorderPoint", bu."name"
        HAVING SUM(s.quantity) > 0 AND SUM(s.quantity) <= COALESCE(p."reorderPoint", p."minimumStock")
        ORDER BY SUM(s.quantity) ASC
        LIMIT 5
      `,

      // ── Expiring soon: up to 5 batches soonest to expire ──
      prisma.batch.findMany({
        where: {
          expiryDate: { gte: today, lte: expirySoonCutoff },
          stock: { some: { quantity: { gt: 0 } } },
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              units: {
                where: { isBaseUnit: true },
                select: { unit: { select: { name: true } } },
                take: 1,
              },
            },
          },
          stock: { select: { quantity: true } },
        },
        orderBy: { expiryDate: "asc" },
        take: 5,
      }),

      // ── Awaiting delivery: up to 5 POs, soonest expected first ──
      prisma.purchaseOrder.findMany({
        where: { status: "AWAITING_DELIVERY" },
        include: { supplier: { select: { name: true } } },
        orderBy: [
          { expectedDeliveryDate: "asc" },
          { createdAt: "asc" },
        ],
        take: 5,
      }),

      // ── Outstanding invoices: up to 5, soonest due first ──
      prisma.supplierInvoice.findMany({
        where: { status: { in: ["OPEN", "PARTIALLY_PAID"] } },
        include: { supplier: { select: { name: true } } },
        orderBy: [
          { dueDate: "asc" },
          { createdAt: "asc" },
        ],
        take: 5,
      }),
    ]);

  const lowStock: LowStockItem[] = lowStockRows.map((row) => ({
    productId: row.productId,
    productName: row.productName,
    sku: row.sku,
    availableStock: Number(row.availableStock),
    reorderPoint: Number(row.reorderPoint),
    baseUnitName: row.baseUnitName ?? "unit",
  }));

  const expiringSoon: ExpiringSoonItem[] = expiringSoonRows.map((b) => {
    const remaining = b.stock.reduce(
      (sum, s) => sum + s.quantity.toNumber(),
      0,
    );
    return {
      batchId: b.id,
      productId: b.productId,
      productName: b.product.name,
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate.toISOString(),
      remainingQuantity: Math.round(remaining * 1000) / 1000,
      baseUnitName: b.product.units[0]?.unit.name ?? "unit",
    };
  });

  const awaitingDelivery: AwaitingDeliveryItem[] = awaitingDeliveryRows.map(
    (po) => ({
      purchaseOrderId: po.id,
      poNumber: po.poNumber,
      supplierName: po.supplier.name,
      expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
    }),
  );

  const outstandingInvoices: OutstandingInvoiceItem[] = invoiceRows.map(
    (inv) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      supplierName: inv.supplier.name,
      outstandingBalance:
        Math.round(inv.outstandingBalance.toNumber() * 100) / 100,
      dueDate: inv.dueDate?.toISOString() ?? null,
    }),
  );

  return { lowStock, expiringSoon, awaitingDelivery, outstandingInvoices };
}

/**
 * GET /dashboard/recent-activity
 *
 * Fetches the last 5 events from 3 operational sources, merges and sorts
 * them by date descending, and returns the 10 most recent.
 *
 * No central audit log exists in the codebase; this query-based approach
 * avoids introducing a new event architecture just for the dashboard.
 */
export async function getDashboardRecentActivity(): Promise<ActivityItem[]> {
  const TAKE = 5;

  const [recentSales, recentReceipts, recentPOs] = await Promise.all([
    prisma.sale.findMany({
      where: { status: "COMPLETED" },
      select: {
        id: true,
        saleNumber: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: { completedAt: "desc" },
      take: TAKE,
    }),

    prisma.goodsReceipt.findMany({
      select: {
        id: true,
        receiptNumber: true,
        receivedDate: true,
        createdAt: true,
        purchaseOrder: {
          select: { supplier: { select: { name: true } } },
        },
      },
      orderBy: { receivedDate: "desc" },
      take: TAKE,
    }),

    prisma.purchaseOrder.findMany({
      where: { status: { not: "CANCELLED" } },
      select: {
        id: true,
        poNumber: true,
        createdAt: true,
        supplier: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: TAKE,
    }),
  ]);

  const activities: ActivityItem[] = [
    ...recentSales.map((s) => ({
      type: "SALE_COMPLETED" as ActivityType,
      reference: s.saleNumber,
      description: "Sale completed",
      createdAt: (s.completedAt ?? s.createdAt).toISOString(),
    })),
    ...recentReceipts.map((gr) => ({
      type: "GOODS_RECEIVED" as ActivityType,
      reference: gr.receiptNumber,
      description: `Goods received from ${gr.purchaseOrder.supplier.name}`,
      createdAt: gr.receivedDate.toISOString(),
    })),
    ...recentPOs.map((po) => ({
      type: "PURCHASE_ORDER_CREATED" as ActivityType,
      reference: po.poNumber,
      description: `Purchase order created for ${po.supplier.name}`,
      createdAt: po.createdAt.toISOString(),
    })),
  ];

  // Sort all merged events newest-first, return top 10.
  activities.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return activities.slice(0, 10);
}
