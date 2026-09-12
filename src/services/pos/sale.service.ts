import {
  Prisma,
  type DiscountType,
  type PaymentMethod,
  type Sale,
} from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { startOfTodayUtc } from "../../utils/date-time.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { recordMovementInTransaction } from "../inventory/stock-movement.service.js";

export type SaleItemInput = {
  productId: string;
  unitId: string;
  /** Quantity entered by the cashier, in the selected unit. */
  quantity: number;
  /** Optional price override. Defaults to ProductUnit.sellPrice. */
  actualUnitPrice?: number;
  discount?: { type: DiscountType; value: number };
};

export type SalePaymentInput = {
  method: PaymentMethod;
  amount: number;
  reference?: string;
};

export type CreateSaleInput = {
  locationId: string;
  items: SaleItemInput[];
  payments: SalePaymentInput[];
  billDiscount?: { type: DiscountType; value: number };
  notes?: string;
};

export type ListSalesQuery = PageQuery & {
  status?: "DRAFT" | "COMPLETED" | "CANCELLED";
  locationId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
};

const saleDetailInclude = {
  location: { select: { id: true, name: true } },
  cashier: { select: { id: true, name: true, email: true } },
  cancelledBy: { select: { id: true, name: true, email: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      unit: { select: { id: true, name: true, symbol: true } },
      batchAllocations: {
        include: {
          batch: {
            select: { id: true, batchNumber: true, expiryDate: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.SaleInclude;

function generateSaleNumber(): string {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return `SL-${yyyymmdd}-${suffix}`;
}

type PreparedItem = {
  productId: string;
  productName: string;
  unitId: string;
  quantity: Prisma.Decimal;
  baseQuantity: Prisma.Decimal;
  conversionFactor: Prisma.Decimal;
  originalUnitPrice: Prisma.Decimal;
  actualUnitPrice: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  discountType: DiscountType | null;
  discountValue: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

/**
 * Validates one sale line inside the transaction and computes every
 * sale-time value (base quantity, prices, discount, line total). All values
 * are persisted on the SaleItem so a completed sale never depends on the
 * current ProductUnit configuration.
 */
async function prepareItem(
  tx: Prisma.TransactionClient,
  item: SaleItemInput,
): Promise<PreparedItem> {
  const product = await tx.product.findUnique({
    where: { id: item.productId },
    select: { id: true, name: true, isActive: true },
  });
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
  if (!product.isActive) {
    throw new AppError(
      409,
      ErrorCode.PRODUCT_INACTIVE,
      `Product "${product.name}" is not active and cannot be sold`,
    );
  }

  const unitConfig = await tx.productUnit.findFirst({
    where: { productId: item.productId, unitId: item.unitId },
    include: { unit: { select: { id: true, isActive: true } } },
  });
  if (!unitConfig) {
    throw new AppError(
      422,
      ErrorCode.INVALID_UNIT,
      "The unit is not configured for the given product",
    );
  }
  if (!unitConfig.unit.isActive) {
    throw new AppError(409, ErrorCode.UNIT_INACTIVE, "Unit is not active");
  }
  if (unitConfig.sellPrice === null) {
    throw new AppError(
      422,
      ErrorCode.UNIT_NO_SELL_PRICE,
      `No selling price is configured for ${product.name} in this unit`,
    );
  }

  // Normalize the entered quantity to the product base unit using the
  // conversion factor at sale time.
  const baseQuantity = roundTo(
    toDecimal(item.quantity).mul(unitConfig.conversionFactor),
    3,
  );
  if (baseQuantity.lte(0)) {
    throw new AppError(
      422,
      ErrorCode.INVALID_STOCK_QUANTITY,
      "Quantity is too small after conversion",
    );
  }

  const originalUnitPrice = unitConfig.sellPrice;
  const actualUnitPrice =
    item.actualUnitPrice !== undefined
      ? toDecimal(item.actualUnitPrice)
      : originalUnitPrice;

  const lineSubtotal = roundTo(actualUnitPrice.mul(toDecimal(item.quantity)), 2);
  let discountAmount = new Prisma.Decimal(0);
  let discountType: DiscountType | null = null;
  let discountValue: Prisma.Decimal | null = null;
  if (item.discount) {
    discountType = item.discount.type;
    discountValue = toDecimal(item.discount.value);
    if (item.discount.type === "PERCENTAGE") {
      discountAmount = roundTo(
        lineSubtotal.mul(discountValue).div(100),
        2,
      );
    } else {
      // A fixed discount can never exceed the pre-discount line total.
      discountAmount = discountValue.gt(lineSubtotal)
        ? lineSubtotal
        : discountValue;
    }
  }
  const lineTotal = roundTo(lineSubtotal.minus(discountAmount), 2);

  return {
    productId: product.id,
    productName: product.name,
    unitId: item.unitId,
    quantity: toDecimal(item.quantity),
    baseQuantity,
    conversionFactor: unitConfig.conversionFactor,
    originalUnitPrice,
    actualUnitPrice,
    lineSubtotal,
    discountType,
    discountValue,
    discountAmount,
    lineTotal,
  };
}

/**
 * Allocates the base quantity of one sale line across batches using
 * FEFO (First Expiry, First Out). Expired batches and batches with no
 * available stock (quantity - reservedQuantity <= 0) are skipped.
 */
async function allocateBatchesFefo(
  tx: Prisma.TransactionClient,
  prepared: PreparedItem,
  locationId: string,
): Promise<Array<{ batchId: string; baseQuantity: Prisma.Decimal }>> {
  const candidates = await tx.inventoryStock.findMany({
    where: {
      productId: prepared.productId,
      locationId,
      quantity: { gt: 0 },
      batch: { expiryDate: { gte: startOfTodayUtc() } },
    },
    include: { batch: { select: { id: true, batchNumber: true, expiryDate: true } } },
    orderBy: { batch: { expiryDate: "asc" } },
  });

  const allocations: Array<{ batchId: string; baseQuantity: Prisma.Decimal }> = [];
  let remaining = prepared.baseQuantity;
  for (const candidate of candidates) {
    if (remaining.lte(0)) {
      break;
    }
    const available = candidate.quantity.minus(candidate.reservedQuantity);
    if (available.lte(0)) {
      continue;
    }
    const take = remaining.gt(available) ? available : remaining;
    allocations.push({ batchId: candidate.batchId, baseQuantity: take });
    remaining = remaining.minus(take);
  }

  if (remaining.gt(0)) {
    throw new AppError(
      409,
      ErrorCode.INSUFFICIENT_STOCK,
      `Insufficient stock for ${prepared.productName}`,
      {
        requested: prepared.baseQuantity.toNumber(),
        available: prepared.baseQuantity.minus(remaining).toNumber(),
      },
    );
  }

  return allocations;
}

export const saleService = {
  /**
   * Completes a sale ATOMICALLY in one database transaction:
   *
   *   validate location -> validate products/units -> calculate prices &
   *   discounts -> validate payments -> FEFO-allocate batches -> create
   *   Sale + SaleItems + SaleItemBatches + SalePayments -> move stock
   *   (SALE/OUT) via the central movement engine -> status COMPLETED.
   *
   * If any step fails, EVERYTHING rolls back: no completed sale without its
   * stock movements, payments and batch allocations — and no stock deducted
   * without a completed sale.
   */
  async complete(input: CreateSaleInput, actor: Pick<AuthenticatedUser, "id">) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // 1. Validate the selling location.
          const location = await tx.inventoryLocation.findUnique({
            where: { id: input.locationId },
            select: { id: true, isActive: true },
          });
          if (!location) {
            throw new AppError(
              404,
              ErrorCode.LOCATION_NOT_FOUND,
              "Location not found",
            );
          }
          if (!location.isActive) {
            throw new AppError(
              409,
              ErrorCode.INACTIVE_LOCATION,
              "Location is not active",
            );
          }

          // 2. Validate each item and compute sale-time values.
          const preparedItems: PreparedItem[] = [];
          for (const item of input.items) {
            preparedItems.push(await prepareItem(tx, item));
          }

          // 3. Totals (subtotal before discounts, bill discount, final total).
          const zero = new Prisma.Decimal(0);
          let subtotal = zero;
          let itemDiscountTotal = zero;
          for (const prepared of preparedItems) {
            subtotal = subtotal.plus(prepared.lineSubtotal);
            itemDiscountTotal = itemDiscountTotal.plus(prepared.discountAmount);
          }
          const beforeBillDiscount = subtotal.minus(itemDiscountTotal);
          let billDiscountAmount = zero;
          if (input.billDiscount) {
            const value = toDecimal(input.billDiscount.value);
            if (input.billDiscount.type === "PERCENTAGE") {
              billDiscountAmount = roundTo(
                beforeBillDiscount.mul(value).div(100),
                2,
              );
            } else {
              billDiscountAmount = value.gt(beforeBillDiscount)
                ? beforeBillDiscount
                : value;
            }
          }
          const totalDiscount = roundTo(
            itemDiscountTotal.plus(billDiscountAmount),
            2,
          );
          const totalAmount = roundTo(subtotal.minus(totalDiscount), 2);

          // 4. Payments (split payments supported). Total payments must
          //    cover the total; the excess is recorded as change.
          let paidAmount = zero;
          const payments = input.payments.map((payment) => {
            paidAmount = paidAmount.plus(toDecimal(payment.amount));
            return {
              method: payment.method,
              amount: toDecimal(payment.amount),
              reference: payment.reference ?? null,
            };
          });
          if (paidAmount.lessThan(totalAmount)) {
            throw new AppError(
              422,
              ErrorCode.INSUFFICIENT_PAYMENT,
              "Total payments are less than the sale total",
              {
                total: totalAmount.toNumber(),
                paid: paidAmount.toNumber(),
              },
            );
          }
          const changeAmount = roundTo(paidAmount.minus(totalAmount), 2);

          // 5. FEFO batch allocation per line.
          const allocationsPerItem: Array<
            Array<{ batchId: string; baseQuantity: Prisma.Decimal }>
          > = [];
          for (const prepared of preparedItems) {
            allocationsPerItem.push(
              await allocateBatchesFefo(tx, prepared, input.locationId),
            );
          }

          // 6. Create the sale with items, batch allocations and payments.
          const sale = await tx.sale.create({
            data: {
              saleNumber: generateSaleNumber(),
              locationId: input.locationId,
              status: "COMPLETED",
              subtotal,
              totalDiscount,
              totalAmount,
              paidAmount,
              changeAmount,
              billDiscountType: input.billDiscount?.type ?? null,
              billDiscountValue: input.billDiscount
                ? toDecimal(input.billDiscount.value)
                : null,
              cashierId: actor.id,
              notes: input.notes ?? null,
              completedAt: new Date(),
              items: {
                create: preparedItems.map((prepared, index) => ({
                  productId: prepared.productId,
                  unitId: prepared.unitId,
                  quantity: prepared.quantity,
                  baseQuantity: prepared.baseQuantity,
                  conversionFactor: prepared.conversionFactor,
                  originalUnitPrice: prepared.originalUnitPrice,
                  actualUnitPrice: prepared.actualUnitPrice,
                  discountType: prepared.discountType,
                  discountValue: prepared.discountValue,
                  discountAmount: prepared.discountAmount,
                  lineTotal: prepared.lineTotal,
                  batchAllocations: {
                    create: allocationsPerItem[index].map((allocation) => ({
                      batchId: allocation.batchId,
                      baseQuantity: allocation.baseQuantity,
                    })),
                  },
                })),
              },
              payments: { create: payments },
            },
            include: saleDetailInclude,
          });

          // 7. Move stock (SALE / OUT) through the central movement engine,
          //    which re-validates availability under a per-(batch, location)
          //    advisory lock and rejects overselling. Allocations are applied
          //    in batchId order so concurrent sales cannot deadlock.
          const allAllocations = allocationsPerItem.flatMap(
            (allocations, index) =>
              allocations.map((allocation) => ({
                productId: preparedItems[index].productId,
                batchId: allocation.batchId,
                baseQuantity: allocation.baseQuantity,
              })),
          );
          allAllocations.sort((a, b) => a.batchId.localeCompare(b.batchId));
          for (const allocation of allAllocations) {
            await recordMovementInTransaction(tx, {
              productId: allocation.productId,
              batchId: allocation.batchId,
              locationId: input.locationId,
              transactionType: "SALE",
              direction: "OUT",
              quantity: allocation.baseQuantity,
              referenceType: "Sale",
              referenceId: sale.id,
              actor,
            });
          }

          return sale;
        },
        {
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      // A write conflict/deadlock between concurrent sales on the same
      // batches: nothing was committed, so a client retry is safe.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        throw new AppError(
          409,
          ErrorCode.CONFLICT,
          "Concurrent stock update detected — please retry the sale",
        );
      }
      throw error;
    }
  },

  async getById(id: string): Promise<Sale> {
    const sale = await prisma.sale.findUnique({
      where: { id },
      include: saleDetailInclude,
    });
    if (!sale) {
      throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
    }
    return sale;
  },

  async list(query: ListSalesQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.SaleWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: query.dateFrom } : {}),
              ...(query.dateTo ? { lte: query.dateTo } : {}),
            },
          }
        : {}),
      ...(query.search
        ? { saleNumber: { contains: query.search, mode: "insensitive" as const } }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.sale.findMany({
        where,
        include: saleDetailInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.sale.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /**
   * Cancels a sale. Only DRAFT sales (which never moved stock) can be
   * cancelled. A COMPLETED sale is terminal in this phase — returns/refunds
   * are intentionally not implemented yet, so completed sales are never
   * un-cancelled or stock-restored here.
   */
  async cancel(
    id: string,
    actor: Pick<AuthenticatedUser, "id">,
    reason?: string,
  ) {
    const sale = await prisma.sale.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!sale) {
      throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
    }
    if (sale.status !== "DRAFT") {
      throw new AppError(
        409,
        ErrorCode.SALE_NOT_CANCELLABLE,
        `A ${sale.status.toLowerCase()} sale cannot be cancelled; completed sales are final until returns are implemented`,
      );
    }

    await prisma.sale.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancelReason: reason ?? null,
      },
    });

    return this.getById(id);
  },
};