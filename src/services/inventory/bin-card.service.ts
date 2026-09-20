import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { startOfTodayUtc, addUtcDays } from "../../utils/date-time.js";
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
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export const binCardService = {
async getBinCard(query: BinCardQuery): Promise<BinCardResult> {
  const {
    productId,
    locationId,
    batchId,
    startDate,
    endDate,
  } = query;

  // ---------------------------------------------------------
  // 1. Validate product + location
  // ---------------------------------------------------------

  const [productData, location] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        units: {
          where: { isBaseUnit: true },
          take: 1,
          select: {
            unit: {
              select: {
                id: true,
                name: true,
                symbol: true,
              },
            },
          },
        },
      },
    }),

    prisma.inventoryLocation.findUnique({
      where: { id: locationId },
      select: { id: true },
    }),
  ]);

  if (!productData) {
    throw new AppError(
      404,
      ErrorCode.PRODUCT_NOT_FOUND,
      "Product not found",
    );
  }

  if (!location) {
    throw new AppError(
      404,
      ErrorCode.LOCATION_NOT_FOUND,
      "Location not found",
    );
  }

  const baseUnit = productData.units[0]?.unit ?? null;

  // ---------------------------------------------------------
  // 2. Resolve date range
  //
  // If no dates are supplied:
  //   default to today
  //
  // Use an exclusive end boundary:
  //   >= start
  //   < endExclusive
  // ---------------------------------------------------------

  const resolvedStartDate = startDate ?? startOfTodayUtc();

  const resolvedEndDateExclusive = endDate
    ? addUtcDays(endDate, 1)
    : addUtcDays(resolvedStartDate, 1);

  // ---------------------------------------------------------
  // 3. Common transaction filter
  // ---------------------------------------------------------

  const transactionWhere: Prisma.StockTransactionWhereInput = {
    productId,
    locationId,
    ...(batchId ? { batchId } : {}),
  };

  // ---------------------------------------------------------
  // 4. Calculate opening balance
  //
  // Everything BEFORE the selected period.
  //
  // Example:
  //
  // Aug 20  +100
  // Aug 25   -20
  // Sep 01   -10
  //
  // Sep 10 opening balance = 70
  // ---------------------------------------------------------

  const openingBalanceResult =
    await prisma.stockTransaction.groupBy({
      by: ["direction"],
      where: {
        ...transactionWhere,
        createdAt: {
          lt: resolvedStartDate,
        },
      },
      _sum: {
        quantity: true,
      },
    });

  let openingBalance = 0;

  for (const row of openingBalanceResult) {
    const quantity = row._sum.quantity?.toNumber() ?? 0;

    if (row.direction === "IN") {
      openingBalance += quantity;
    } else if (row.direction === "OUT") {
      openingBalance -= quantity;
    }
  }

  // ---------------------------------------------------------
  // 5. Pagination
  // ---------------------------------------------------------

  const { skip, take, page, limit } = resolvePagination(query);

  // ---------------------------------------------------------
  // 6. Date-range filter
  //
  // IMPORTANT:
  //
  // startDate <= transaction < endDateExclusive
  //
  // This prevents accidentally excluding the rest of endDate.
  // ---------------------------------------------------------

  const rangeWhere: Prisma.StockTransactionWhereInput = {
    ...transactionWhere,
    createdAt: {
      gte: resolvedStartDate,
      lt: resolvedEndDateExclusive,
    },
  };

  // ---------------------------------------------------------
  // 7. Find the balance immediately BEFORE this page
  //
  // This fixes the pagination problem.
  //
  // Page 1:
  //   starting balance = openingBalance
  //
  // Page 2:
  //   starting balance =
  //   openingBalance + all transactions before page 2
  //
  // Page 3:
  //   same idea...
  // ---------------------------------------------------------

  let pageOpeningBalance = openingBalance;

  if (skip > 0) {
    const transactionsBeforePage = await prisma.stockTransaction.findMany({
      where: rangeWhere,
      select: {
        direction: true,
        quantity: true,
      },
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: skip,
    });

    for (const tx of transactionsBeforePage) {
      const quantity = tx.quantity.toNumber();

      if (tx.direction === "IN") {
        pageOpeningBalance += quantity;
      } else if (tx.direction === "OUT") {
        pageOpeningBalance -= quantity;
      }
    }
  }

  // ---------------------------------------------------------
  // 8. Fetch requested page + total count
  // ---------------------------------------------------------

  const [transactions, total] = await prisma.$transaction([
    prisma.stockTransaction.findMany({
      where: rangeWhere,
      include: {
        batch: {
          select: {
            id: true,
            batchNumber: true,
            expiryDate: true,
            purchaseCost: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
      skip,
      take,
    }),

    prisma.stockTransaction.count({
      where: rangeWhere,
    }),
  ]);

  // ---------------------------------------------------------
  // 9. Calculate running balance for this page
  // ---------------------------------------------------------

  let runningBalance = pageOpeningBalance;

  const binCardTransactions: BinCardTransaction[] =
    transactions.map((tx) => {
      const quantity = tx.quantity.toNumber();

      const inQty =
        tx.direction === "IN"
          ? quantity
          : 0;

      const outQty =
        tx.direction === "OUT"
          ? quantity
          : 0;

      if (tx.direction === "IN") {
        runningBalance += quantity;
      } else if (tx.direction === "OUT") {
        runningBalance -= quantity;
      }

      return {
        transactionId: tx.id,

        date: tx.createdAt,

        reference:
          tx.referenceType && tx.referenceId
            ? `${tx.referenceType}:${tx.referenceId}`
            : null,

        transactionType: tx.transactionType,

        direction: tx.direction,

        in: inQty,

        out: outQty,

        balance: runningBalance,

        notes: tx.notes ?? null,

        batch: tx.batch
          ? {
              id: tx.batch.id,
              batchNumber: tx.batch.batchNumber,
              expiryDate: tx.batch.expiryDate,
            }
          : null,

        costPrice:
          tx.batch?.purchaseCost?.toNumber() ?? null,

        user: tx.createdBy,
      };
    });

  // ---------------------------------------------------------
  // 10. Return result
  // ---------------------------------------------------------

  return {
    baseUnit,

    // Balance at the beginning of the selected period.
    openingBalance,

    // Transactions for the requested page.
    transactions: binCardTransactions,

    // IMPORTANT:
    //
    // On a paginated result this is the balance at the END
    // of the CURRENT PAGE, not necessarily the final balance
    // of the entire selected date range.
    closingBalance: runningBalance,

    // Pagination metadata
    total,
    page,
    pageSize: limit,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}
}


