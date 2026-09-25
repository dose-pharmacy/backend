import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

type CreditSaleRow = {
  id: string;
  saleNumber: string;
  locationId: string;
  status: string;
  subtotal: Prisma.Decimal;
  totalDiscount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  changeAmount: Prisma.Decimal;
  billDiscountType: string | null;
  billDiscountValue: Prisma.Decimal | null;
  cashierId: string;
  notes: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledById: string | null;
  cancelReason: string | null;
  customerName: string | null;
  customerPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreditSaleStatus = "OUTSTANDING" | "PARTIALLY_PAID" | "PAID" | "ALL";

export type CreditSalesQuery = PageQuery & {
  customerName?: string;
  customerPhone?: string;
  saleNumber?: string;
  status?: CreditSaleStatus;
  locationId?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

const creditSaleDetailInclude = {
  location: { select: { id: true, name: true } },
  cashier: { select: { id: true, name: true, email: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true, isNarcotic: true } },
      unit: { select: { id: true, name: true, symbol: true } },
      batchAllocations: {
        include: {
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.SaleInclude;

// For complex status filters (PARTIALLY_PAID, PAID) we need to use raw SQL
// or post-process. For now, we'll handle it in the list function.

export const creditSalesService = {
  async list(query: CreditSalesQuery) {
    const { page, limit, skip } = resolvePagination(query);

    // Base where clause for credit sales (sales that have/had customer info)
    // Using raw SQL for proper pagination with status filter
    const statusFilter = query.status || "ALL";

    let whereClause = `
      WHERE s.status = 'COMPLETED'
      AND (s."customerName" IS NOT NULL OR s."customerPhone" IS NOT NULL)
    `;
    const params: unknown[] = [];

    if (query.locationId) {
      params.push(query.locationId);
      whereClause += ` AND s."locationId" = $${params.length}`;
    }
    if (query.dateFrom) {
      params.push(query.dateFrom);
      whereClause += ` AND s."createdAt" >= $${params.length}`;
    }
    if (query.dateTo) {
      params.push(query.dateTo);
      whereClause += ` AND s."createdAt" <= $${params.length}`;
    }
    if (query.customerName) {
      params.push(`%${query.customerName}%`);
      whereClause += ` AND s."customerName" ILIKE $${params.length}`;
    }
    if (query.customerPhone) {
      params.push(`%${query.customerPhone}%`);
      whereClause += ` AND s."customerPhone" ILIKE $${params.length}`;
    }
    if (query.saleNumber) {
      params.push(`%${query.saleNumber}%`);
      whereClause += ` AND s."saleNumber" ILIKE $${params.length}`;
    }

    // Status filter using computed outstanding
    if (statusFilter === "OUTSTANDING") {
      whereClause += ` AND s."paidAmount" = 0`;
    } else if (statusFilter === "PARTIALLY_PAID") {
      whereClause += ` AND s."paidAmount" > 0 AND s."paidAmount" < s."totalAmount"`;
    } else if (statusFilter === "PAID") {
      whereClause += ` AND s."paidAmount" >= s."totalAmount"`;
    }

    // Count total
    const countQuery = `SELECT COUNT(*) FROM "sale" s ${whereClause}`;
    const countResult = await prisma.$queryRawUnsafe<[{ count: bigint }]>(countQuery, ...params);
    const total = Number(countResult[0]?.count ?? 0);

    // Fetch paginated results
    params.push(limit, skip);
    const selectQuery = `
      SELECT s.* FROM "sale" s ${whereClause}
      ORDER BY s."createdAt" DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const sales = await prisma.$queryRawUnsafe<CreditSaleRow[]>(selectQuery, ...params);

    // Fetch related data for each sale
    const saleIds: string[] = sales.map((s) => s.id);
    const [locations, cashiers, paymentsResult, itemCounts] = await Promise.all([
      saleIds.length > 0
        ? prisma.inventoryLocation.findMany({
            where: { id: { in: sales.map((s) => s.locationId) } },
            select: { id: true, name: true },
          })
        : ([] as { id: string; name: string }[]),
      saleIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: sales.map((s) => s.cashierId) } },
            select: { id: true, name: true },
          })
        : ([] as { id: string; name: string }[]),
      saleIds.length > 0
        ? prisma.salePayment.findMany({
            where: { saleId: { in: saleIds } },
            orderBy: { createdAt: "asc" },
          })
        : ([] as { id: string; saleId: string; method: "CASH" | "CARD" | "DIGITAL_TRANSFER"; amount: Prisma.Decimal; reference: string | null; createdAt: Date }[]),
      saleIds.length > 0
        ? prisma.saleItem.groupBy({
            by: ["saleId"],
            where: { saleId: { in: saleIds } },
            _count: { id: true },
          })
        : ([] as { saleId: string; _count: { id: number } }[]),
    ]);

    const locationMap = new Map(locations.map((l) => [l.id, l]));
    const cashierMap = new Map(cashiers.map((c) => [c.id, c]));
    const paymentsMap = new Map<string, typeof paymentsResult>();
    for (const p of paymentsResult) {
      if (!paymentsMap.has(p.saleId)) paymentsMap.set(p.saleId, []);
      paymentsMap.get(p.saleId)!.push(p);
    }
    const itemCountMap = new Map(itemCounts.map((ic) => [ic.saleId, ic._count.id]));

    const items = sales.map((sale) => ({
      ...sale,
      totalAmount: sale.totalAmount.toNumber(),
      subtotal: sale.subtotal.toNumber(),
      totalDiscount: sale.totalDiscount.toNumber(),
      paidAmount: sale.paidAmount.toNumber(),
      changeAmount: sale.changeAmount.toNumber(),
      outstandingAmount: Math.max(0, sale.totalAmount.toNumber() - sale.paidAmount.toNumber()),
      paymentStatus: sale.paidAmount.equals(0)
        ? "OUTSTANDING"
        : sale.paidAmount.gte(sale.totalAmount)
          ? "PAID"
          : "PARTIALLY_PAID",
      location: locationMap.get(sale.locationId),
      cashier: cashierMap.get(sale.cashierId),
      payments: paymentsMap.get(sale.id)?.map((p) => ({
        ...p,
        amount: p.amount.toNumber(),
      })) || [],
      _count: {
        items: itemCountMap.get(sale.id) ?? 0,
        payments: paymentsMap.get(sale.id)?.length ?? 0,
      },
    }));

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const sale = await prisma.sale.findUnique({
      where: { id },
      include: creditSaleDetailInclude,
    });

    if (!sale) {
      throw new Error("Sale not found");
    }

    const totalAmount = sale.totalAmount.toNumber();
    const paidAmount = sale.paidAmount.toNumber();
    const outstandingAmount = Math.max(0, totalAmount - paidAmount);

    return {
      ...sale,
      totalAmount,
      subtotal: sale.subtotal.toNumber(),
      totalDiscount: sale.totalDiscount.toNumber(),
      paidAmount,
      changeAmount: sale.changeAmount.toNumber(),
      outstandingAmount,
      paymentStatus: paidAmount === 0
        ? "OUTSTANDING"
        : paidAmount >= totalAmount
          ? "PAID"
          : "PARTIALLY_PAID",
      items: sale.items.map((item) => ({
        ...item,
        quantity: item.quantity.toNumber(),
        baseQuantity: item.baseQuantity.toNumber(),
        lineTotal: item.lineTotal.toNumber(),
        originalUnitPrice: item.originalUnitPrice.toNumber(),
        actualUnitPrice: item.actualUnitPrice.toNumber(),
        conversionFactor: item.conversionFactor.toNumber(),
        batchAllocations: item.batchAllocations.map((ba) => ({
          ...ba,
          baseQuantity: ba.baseQuantity.toNumber(),
        })),
      })),
      payments: sale.payments.map((p) => ({
        ...p,
        amount: p.amount.toNumber(),
      })),
    };
  },
};