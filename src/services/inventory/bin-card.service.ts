import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { startOfTodayUtc } from "../../utils/date-time.js";
import { resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type BinCardQuery = PageQuery & {
  productId: string;
  locationId: string;
  batchId?: string;
  startDate?: Date;
  endDate?: Date;
};

export type BinCardTransaction = {
  transactionId: string;
  date: Date;
  reference: string | null;
  transactionType: string;
  direction: "IN" | "OUT";
  in: number;
  out: number;
  balance: number;
  notes: string | null;
  batch: {
    id: string;
    batchNumber: string;
    expiryDate: Date;
  } | null;
  costPrice: number | null;
  user: { id: string; name: string; email: string } | null;
};

export type BinCardResult = {
  baseUnit: { id: string; name: string; symbol: string | null } | null;
  openingBalance: number;
  transactions: BinCardTransaction[];
  closingBalance: number;
};

export const binCardService = {
  async getBinCard(query: BinCardQuery): Promise<BinCardResult> {
    const { productId, locationId, batchId, startDate, endDate } = query;

    // Validate product and location exist and fetch base unit in one go
    const [productData, location] = await Promise.all([
      prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          units: {
            where: { isBaseUnit: true },
            take: 1,
            select: { unit: { select: { id: true, name: true, symbol: true } } },
          },
        },
      }),
      prisma.inventoryLocation.findUnique({ where: { id: locationId }, select: { id: true } }),
    ]);

    if (!productData) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }
    if (!location) {
      throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
    }
    const baseUnit = productData.units[0]?.unit ?? null;

    // Build where clause for transactions
    const transactionWhere: Prisma.StockTransactionWhereInput = {
      productId,
      locationId,
      ...(batchId ? { batchId } : {}),
    };

    // For opening balance, get all transactions BEFORE startDate
    const openingBalanceWhere = {
      ...transactionWhere,
      createdAt: {
        lt: startDate ?? startOfTodayUtc(),
      },
    };

    // We need to calculate opening balance correctly: sum IN - sum OUT
    const openingBalanceResult = await prisma.stockTransaction.groupBy({
      by: ["direction"],
      where: openingBalanceWhere,
      _sum: { quantity: true },
    });

    let openingBalance = 0;
    for (const row of openingBalanceResult) {
      const qty = row._sum.quantity?.toNumber() ?? 0;
      if (row.direction === "IN") {
        openingBalance += qty;
      } else {
        openingBalance -= qty;
      }
    }

    // Get transactions within the date range
    const rangeWhere: Prisma.StockTransactionWhereInput = {
      ...transactionWhere,
      createdAt: {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {}),
      },
    };

    const { skip, take } = resolvePagination(query);

    const [transactions] = await prisma.$transaction([
      prisma.stockTransaction.findMany({
        where: rangeWhere,
        include: {
          batch: { select: { id: true, batchNumber: true, expiryDate: true, purchaseCost: true } },
          createdBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip,
        take,
      }),
      prisma.stockTransaction.count({ where: rangeWhere }),
    ]);

    // Calculate running balance
    let runningBalance = openingBalance;
    const binCardTransactions: BinCardTransaction[] = transactions.map((tx) => {
      const quantity = tx.quantity.toNumber();
      const inQty = tx.direction === "IN" ? quantity : 0;
      const outQty = tx.direction === "OUT" ? quantity : 0;

      if (tx.direction === "IN") {
        runningBalance += quantity;
      } else {
        runningBalance -= quantity;
      }

      return {
        transactionId: tx.id,
        date: tx.createdAt,
        reference: tx.referenceType && tx.referenceId
          ? `${tx.referenceType}:${tx.referenceId}`
          : null,
        transactionType: tx.transactionType,
        direction: tx.direction,
        in: inQty,
        out: outQty,
        balance: runningBalance,
        notes: tx.notes ?? null,
        batch: tx.batch
          ? { id: tx.batch.id, batchNumber: tx.batch.batchNumber, expiryDate: tx.batch.expiryDate }
          : null,
        costPrice: tx.batch?.purchaseCost?.toNumber() ?? null,
        user: tx.createdBy,
      };
    });

    return {
      baseUnit,
      openingBalance,
      transactions: binCardTransactions,
      closingBalance: runningBalance,
    };
  },
};