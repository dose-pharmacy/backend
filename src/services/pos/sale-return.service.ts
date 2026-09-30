import { Prisma, type PaymentMethod } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { isExpired } from "../../utils/date-time.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { recordMovementInTransaction } from "../inventory/stock-movement.service.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";

// ============================================================================
// POS customer product returns
// ============================================================================
//
// A return NEVER modifies the original Sale/SaleItem: the completed sale is
// historical truth. All return history is recorded separately in
// SaleReturn/SaleReturnItem, each row pointing at the exact original SaleItem
// (never a productId — the same product can be sold several times at different
// prices and discounts).
//
// The core invariant, enforced server-side inside the transaction:
//
//     totalReturnedQuantity <= originalSoldQuantity
//
// ============================================================================

const MONEY_SCALE = 2;
const STOCK_SCALE = 3;

/**
 * Tolerance used when matching returned base quantities back to the batches a
 * line was sold from. `SaleItem.baseQuantity` and each `SaleReturnItem`
 * `baseQuantity` are independently rounded to 3 dp, so splitting a line across
 * several returns can leave sub-0.001 base-unit residue. The tolerance is the
 * storage precision of a stock quantity, so it is invisible in inventory terms.
 */
const BATCH_ALLOCATION_TOLERANCE = toDecimal(0.001);

export type SaleReturnItemInput = {
  saleItemId: string;
  /** Quantity in the unit the customer received the item in (the sale's unit). */
  quantity: number;
  /** When false the return + refund are recorded but inventory is not restored. */
  restock?: boolean;
  reason?: string;
};

export type CreateSaleReturnInput = {
  items: SaleReturnItemInput[];
  refundMethod: PaymentMethod;
  refundReference?: string;
  reason?: string;
  notes?: string;
  idempotencyKey?: string;
};

export type ListSaleReturnsQuery = PageQuery & {
  saleId?: string;
  locationId?: string;
  productId?: string;
  refundMethod?: PaymentMethod;
  restock?: "true" | "false";
  dateFrom?: Date;
  dateTo?: Date;
};

/** Minimal sale fields needed to price a return. */
type SalePricingHeader = {
  subtotal: Prisma.Decimal;
  totalDiscount: Prisma.Decimal;
};

/** Minimal sale-line fields needed to price a return. */
type SaleItemPricing = {
  quantity: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

const saleReturnDetailInclude = {
  sale: {
    select: {
      id: true,
      saleNumber: true,
      status: true,
      subtotal: true,
      totalDiscount: true,
      totalAmount: true,
      completedAt: true,
    },
  },
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      unit: { select: { id: true, name: true, symbol: true } },
      batchAllocations: {
        include: {
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        },
        orderBy: { batchId: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.SaleReturnInclude;

export type SaleReturnDetail = Prisma.SaleReturnGetPayload<{
  include: typeof saleReturnDetailInclude;
}>;

// ============================================================================
// Pricing
// ============================================================================

/**
 * This line's share of the BILL-level discount, allocated in proportion to the
 * line's gross amount.
 *
 * The POS applies discounts at bill level only (`Sale.totalDiscount`), never
 * per item, so a return must refund the DISCOUNTED value. Paying out the
 * undiscounted list price would hand the customer back more than they paid.
 */
export function billDiscountShareForItem(
  sale: SalePricingHeader,
  item: SaleItemPricing,
): Prisma.Decimal {
  if (sale.subtotal.lte(0)) {
    return new Prisma.Decimal(0);
  }
  const share = sale.totalDiscount.mul(item.lineTotal).div(sale.subtotal);
  return roundTo(share, MONEY_SCALE);
}

/**
 * Net (post-discount) value attributable to one original sale line. This is
 * the authoritative "what the customer actually paid for this line" figure,
 * derived purely from the original sale's stored values.
 */
export function netLineTotalForItem(
  sale: SalePricingHeader,
  item: SaleItemPricing,
): Prisma.Decimal {
  const net = item.lineTotal.minus(billDiscountShareForItem(sale, item));
  // Defensive: a line can never be worth less than zero, even if the stored
  // totals were inconsistent.
  return roundTo(Prisma.Decimal.max(net, 0), MONEY_SCALE);
}

/** Effective net unit price of a line: net line total / quantity sold. */
export function netUnitPriceForItem(
  netLineTotal: Prisma.Decimal,
  quantitySold: Prisma.Decimal,
): Prisma.Decimal {
  if (quantitySold.lte(0)) {
    return new Prisma.Decimal(0);
  }
  return roundTo(netLineTotal.div(quantitySold), MONEY_SCALE);
}

/**
 * Refund owed for one return of one line.
 *
 * Proportional to the line's NET value (never today's product price, never the
 * undiscounted list price), except when the return closes the line out, which
 * then refunds the exact remaining amount. That combination guarantees:
 *
 *   - sum(refunds) never exceeds the line's net total, so
 *     `refund = original sale value for the quantity actually returned` holds
 *     on every single return, not just the last one, and
 *   - returning a line in full refunds its net total exactly, with no cents
 *     stranded and unable to be claimed.
 *
 * `alreadyReturnedQuantity` is how much of the line was returned BEFORE this
 * one — the line closes out when THIS return consumes what was left, not when
 * this return alone is large relative to the original quantity.
 */
export function refundAmountForQuantity(params: {
  netLineTotal: Prisma.Decimal;
  quantitySold: Prisma.Decimal;
  /** Quantity already returned across all previous returns of this line. */
  alreadyReturnedQuantity: Prisma.Decimal;
  alreadyRefunded: Prisma.Decimal;
  /** Quantity being returned now. */
  quantityReturning: Prisma.Decimal;
}): Prisma.Decimal {
  const {
    netLineTotal,
    quantitySold,
    alreadyReturnedQuantity,
    alreadyRefunded,
    quantityReturning,
  } = params;

  const remainingRefundable = roundTo(
    Prisma.Decimal.max(netLineTotal.minus(alreadyRefunded), 0),
    MONEY_SCALE,
  );
  if (remainingRefundable.lte(0) || quantitySold.lte(0)) {
    return new Prisma.Decimal(0);
  }

  const remainingQuantity = roundTo(
    Prisma.Decimal.max(quantitySold.minus(alreadyReturnedQuantity), 0),
    STOCK_SCALE,
  );
  const closesOutTheLine = quantityReturning.gte(remainingQuantity);

  const proportional = roundTo(
    netLineTotal.mul(quantityReturning).div(quantitySold),
    MONEY_SCALE,
  );

  const refund = closesOutTheLine
    ? remainingRefundable
    : Prisma.Decimal.min(proportional, remainingRefundable);

  return roundTo(Prisma.Decimal.max(refund, 0), MONEY_SCALE);
}

// ============================================================================
// Helpers
// ============================================================================

function generateReturnNumber(): string {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return `RTN-${yyyymmdd}-${suffix}`;
}

/**
 * Serialises concurrent writers for one logical resource. `pg_advisory_xact_lock`
 * is transaction-scoped, so it is released automatically on commit/rollback and
 * a crashed writer can never strand the lock.
 */
async function lockAdvisory(
  tx: Prisma.TransactionClient,
  key: string,
): Promise<void> {
  // $executeRaw because pg_advisory_xact_lock returns void, which $queryRaw
  // cannot deserialize.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

type ReturnedAggregates = {
  /** Returned quantity per sale item, in the sold unit. */
  quantityBySaleItem: Map<string, Prisma.Decimal>;
  /** Refunded money per sale item. */
  refundBySaleItem: Map<string, Prisma.Decimal>;
  /**
   * Base quantity already put back into each (saleItem, batch) pair. Only
   * restockable returns allocate batches, so this is exactly the quantity that
   * has left that batch's sellable pool.
   */
  baseBySaleItemBatch: Map<string, Prisma.Decimal>;
};

function batchAggregateKey(saleItemId: string, batchId: string): string {
  return `${saleItemId}::${batchId}`;
}

/**
 * Single query that answers "how much of each original sale line has already
 * been returned, and how much of each batch has already been restocked".
 */
async function aggregateReturned(
  client: Prisma.TransactionClient | typeof prisma,
  saleItemIds: string[],
): Promise<ReturnedAggregates> {
  const quantityBySaleItem = new Map<string, Prisma.Decimal>();
  const refundBySaleItem = new Map<string, Prisma.Decimal>();
  const baseBySaleItemBatch = new Map<string, Prisma.Decimal>();

  if (saleItemIds.length === 0) {
    return { quantityBySaleItem, refundBySaleItem, baseBySaleItemBatch };
  }

  const rows = await client.saleReturnItem.findMany({
    where: { saleItemId: { in: saleItemIds } },
    select: {
      saleItemId: true,
      quantity: true,
      refundAmount: true,
      batchAllocations: { select: { batchId: true, baseQuantity: true } },
    },
  });

  for (const row of rows) {
    quantityBySaleItem.set(
      row.saleItemId,
      (quantityBySaleItem.get(row.saleItemId) ?? new Prisma.Decimal(0)).plus(
        row.quantity,
      ),
    );
    refundBySaleItem.set(
      row.saleItemId,
      (refundBySaleItem.get(row.saleItemId) ?? new Prisma.Decimal(0)).plus(
        row.refundAmount,
      ),
    );
    for (const allocation of row.batchAllocations) {
      const key = batchAggregateKey(row.saleItemId, allocation.batchId);
      baseBySaleItemBatch.set(
        key,
        (baseBySaleItemBatch.get(key) ?? new Prisma.Decimal(0)).plus(
          allocation.baseQuantity,
        ),
      );
    }
  }

  return { quantityBySaleItem, refundBySaleItem, baseBySaleItemBatch };
}

/**
 * Splits the returned base quantity back across the batches the line was
 * originally sold from, in the original allocation order (oldest allocation
 * first). This is the reverse of the sale's FEFO allocation: goods come back
 * to the same batches they left, never to an arbitrary batch chosen by
 * convenience.
 */
function allocateReturnToOriginalBatches(params: {
  /** SaleItemBatch rows in original allocation order. */
  allocations: Array<{ batchId: string; baseQuantity: Prisma.Decimal }>;
  alreadyReturnedByBatch: Map<string, Prisma.Decimal>;
  requestedBaseQuantity: Prisma.Decimal;
  absorbsRoundingResidue: boolean;
}): Array<{ batchId: string; baseQuantity: Prisma.Decimal }> {
  const { allocations, alreadyReturnedByBatch } = params;
  let remaining = params.requestedBaseQuantity;
  const result: Array<{ batchId: string; baseQuantity: Prisma.Decimal }> = [];

  for (const allocation of allocations) {
    if (remaining.lte(0)) {
      break;
    }
    const already = alreadyReturnedByBatch.get(allocation.batchId) ?? new Prisma.Decimal(0);
    const available = Prisma.Decimal.max(
      allocation.baseQuantity.minus(already),
      0,
    );
    if (available.lte(0)) {
      continue;
    }
    const take = remaining.gt(available) ? available : remaining;
    result.push({ batchId: allocation.batchId, baseQuantity: take });
    remaining = remaining.minus(take);
  }

  // Sub-precision residue from independent 3 dp roundings. When the return
  // closes out the line, absorb it so a full return restores the full
  // originally-sold base quantity of that batch.
  if (remaining.gt(0) && params.absorbsRoundingResidue) {
    const pool = allocations
      .map(
        (allocation) =>
          Prisma.Decimal.max(
            allocation.baseQuantity.minus(
              alreadyReturnedByBatch.get(allocation.batchId) ?? new Prisma.Decimal(0),
            ),
            0,
          ),
      )
      .reduce((sum, value) => sum.plus(value), new Prisma.Decimal(0));
    const outstanding = roundTo(remaining, STOCK_SCALE);
    if (outstanding.lte(BATCH_ALLOCATION_TOLERANCE) && pool.gt(0)) {
      result.push({ batchId: allocations[allocations.length - 1].batchId, baseQuantity: outstanding });
      remaining = new Prisma.Decimal(0);
    }
  }

  if (remaining.gt(0)) {
    throw new AppError(
      409,
      ErrorCode.RETURN_BATCH_ALLOCATION_FAILED,
      "The returned quantity could not be matched back to the batches this line was sold from",
      { outstanding: roundTo(remaining, STOCK_SCALE).toNumber() },
    );
  }

  return result;
}

// ============================================================================
// Return information (read)
// ============================================================================

type ReturnInfoItem = {
  saleItemId: string;
  product: { id: string; name: string; sku: string; isNarcotic: boolean };
  unit: { id: string; name: string; symbol: string | null };
  quantitySold: Prisma.Decimal;
  baseQuantitySold: Prisma.Decimal;
  quantityReturned: Prisma.Decimal;
  quantityReturnable: Prisma.Decimal;
  baseQuantityReturned: Prisma.Decimal;
  baseQuantityReturnable: Prisma.Decimal;
  originalUnitPrice: Prisma.Decimal;
  actualUnitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  billDiscountShare: Prisma.Decimal;
  netLineTotal: Prisma.Decimal;
  netUnitPrice: Prisma.Decimal;
  amountRefunded: Prisma.Decimal;
  amountReturnable: Prisma.Decimal;
  batchAllocations: Array<{
    batchId: string;
    batchNumber: string;
    expiryDate: Date;
    expired: boolean;
    baseQuantity: Prisma.Decimal;
    baseQuantityReturned: Prisma.Decimal;
    baseQuantityReturnable: Prisma.Decimal;
  }>;
};

/**
 * Everything the POS needs to render the return screen for one sale:
 * the original sold quantities, how much has already been returned, what is
 * still returnable, the ORIGINAL prices/net amounts and the batches the line
 * was sold from.
 *
 * Read-only: nothing here is ever used to authorise a return (the create path
 * recomputes everything inside its own transaction).
 */
async function loadReturnInfo(
  client: Prisma.TransactionClient | typeof prisma,
  saleId: string,
) {
  const sale = await client.sale.findUnique({
    where: { id: saleId },
    select: {
      id: true,
      saleNumber: true,
      status: true,
      locationId: true,
      subtotal: true,
      totalDiscount: true,
      totalAmount: true,
      completedAt: true,
      location: { select: { id: true, name: true, isActive: true } },
      items: {
        select: {
          id: true,
          productId: true,
          unitId: true,
          quantity: true,
          baseQuantity: true,
          conversionFactor: true,
          originalUnitPrice: true,
          actualUnitPrice: true,
          lineTotal: true,
          product: { select: { id: true, name: true, sku: true, isNarcotic: true } },
          unit: { select: { id: true, name: true, symbol: true } },
          batchAllocations: {
            select: {
              batchId: true,
              baseQuantity: true,
              batch: { select: { batchNumber: true, expiryDate: true } },
            },
            orderBy: [{ createdAt: "asc" }, { batchId: "asc" }],
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!sale) {
    throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
  }

  const saleItemIds = sale.items.map((item) => item.id);
  const aggregates = await aggregateReturned(client, saleItemIds);

  const items: ReturnInfoItem[] = sale.items.map((item) => {
    const quantityReturned =
      aggregates.quantityBySaleItem.get(item.id) ?? new Prisma.Decimal(0);
    const refundAmount =
      aggregates.refundBySaleItem.get(item.id) ?? new Prisma.Decimal(0);

    const quantityReturnable = roundTo(
      Prisma.Decimal.max(item.quantity.minus(quantityReturned), 0),
      STOCK_SCALE,
    );

    const billDiscountShare = billDiscountShareForItem(sale, item);
    const netLineTotal = netLineTotalForItem(sale, item);

    const batchAllocations = item.batchAllocations.map((allocation) => {
      const baseQuantityReturned =
        aggregates.baseBySaleItemBatch.get(
          batchAggregateKey(item.id, allocation.batchId),
        ) ?? new Prisma.Decimal(0);
      return {
        batchId: allocation.batchId,
        batchNumber: allocation.batch.batchNumber,
        expiryDate: allocation.batch.expiryDate,
        expired: isExpired(allocation.batch.expiryDate),
        baseQuantity: allocation.baseQuantity,
        baseQuantityReturned,
        baseQuantityReturnable: roundTo(
          Prisma.Decimal.max(
            allocation.baseQuantity.minus(baseQuantityReturned),
            0,
          ),
          STOCK_SCALE,
        ),
      };
    });

    const baseQuantityReturned = batchAllocations.reduce(
      (sum, allocation) => sum.plus(allocation.baseQuantityReturned),
      new Prisma.Decimal(0),
    );

    return {
      saleItemId: item.id,
      product: item.product,
      unit: item.unit,
      quantitySold: item.quantity,
      baseQuantitySold: item.baseQuantity,
      quantityReturned,
      quantityReturnable,
      baseQuantityReturned,
      baseQuantityReturnable: roundTo(
        Prisma.Decimal.max(item.baseQuantity.minus(baseQuantityReturned), 0),
        STOCK_SCALE,
      ),
      originalUnitPrice: item.originalUnitPrice,
      actualUnitPrice: item.actualUnitPrice,
      lineTotal: item.lineTotal,
      billDiscountShare,
      netLineTotal,
      netUnitPrice: netUnitPriceForItem(netLineTotal, item.quantity),
      amountRefunded: roundTo(refundAmount, MONEY_SCALE),
      amountReturnable: roundTo(
        Prisma.Decimal.max(netLineTotal.minus(refundAmount), 0),
        MONEY_SCALE,
      ),
      batchAllocations,
    };
  });

  const returns = await client.saleReturn.findMany({
    where: { saleId: sale.id },
    select: {
      id: true,
      returnNumber: true,
      refundAmount: true,
      refundMethod: true,
      refundReference: true,
      reason: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
      items: {
        select: {
          id: true,
          saleItemId: true,
          quantity: true,
          refundAmount: true,
          restock: true,
          product: { select: { id: true, name: true, sku: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    sale: {
      id: sale.id,
      saleNumber: sale.saleNumber,
      status: sale.status,
      returnable: sale.status === "COMPLETED",
      location: sale.location,
      subtotal: sale.subtotal,
      totalDiscount: sale.totalDiscount,
      totalAmount: sale.totalAmount,
      completedAt: sale.completedAt,
    },
    items,
    returns,
    totalRefunded: returns.reduce(
      (sum, saleReturn) => sum.plus(saleReturn.refundAmount),
      new Prisma.Decimal(0),
    ),
  };
}

// ============================================================================
// Service
// ============================================================================

export const saleReturnService = {
  /** Return information for one sale (read-only). */
  async getReturnInfo(saleId: string) {
    return loadReturnInfo(prisma, saleId);
  },

  async getById(id: string): Promise<SaleReturnDetail> {
    const saleReturn = await prisma.saleReturn.findUnique({
      where: { id },
      include: saleReturnDetailInclude,
    });
    if (!saleReturn) {
      throw new AppError(
        404,
        ErrorCode.SALE_RETURN_NOT_FOUND,
        "Sale return not found",
      );
    }
    return saleReturn;
  },

  async list(query: ListSaleReturnsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const itemFilters: Prisma.SaleReturnItemWhereInput[] = [];
    if (query.productId) {
      itemFilters.push({ productId: query.productId });
    }
    if (query.restock !== undefined) {
      itemFilters.push({ restock: query.restock === "true" });
    }

    const where: Prisma.SaleReturnWhereInput = {
      ...(query.saleId ? { saleId: query.saleId } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.refundMethod ? { refundMethod: query.refundMethod } : {}),
      ...(itemFilters.length ? { items: { some: { AND: itemFilters } } } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: query.dateFrom } : {}),
              ...(query.dateTo ? { lte: query.dateTo } : {}),
            },
          }
        : {}),
    };

    const [items, total, refunded] = await prisma.$transaction([
      prisma.saleReturn.findMany({
        where,
        include: saleReturnDetailInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.saleReturn.count({ where }),
      prisma.saleReturn.aggregate({ where, _sum: { refundAmount: true } }),
    ]);

    return {
      items,
      meta: buildPaginationMeta(total, page, limit),
      summary: {
        refundAmount: (refunded._sum.refundAmount ?? new Prisma.Decimal(0)).toNumber(),
      },
    };
  },

  /**
   * Creates a customer return against a COMPLETED sale ATOMICALLY:
   *
   *   validate + lock the sale and the requested sale items -> recompute
   *   already-returned quantities -> validate the requested quantities ->
   *   compute refunds from the ORIGINAL sale values -> create the SaleReturn
   *   -> create the SaleReturnItems (+ batch splits) -> write the immediate
   *   refund on the return -> restore inventory with RETURN_IN movements ->
   *   audit.
   *
   * If anything fails, EVERYTHING rolls back. There is never a refund without
   * its return, a return without its refund, or a return whose stock was not
   * restored.
   *
   * Concurrency: each requested sale item is locked with a transaction-scoped
   * PostgreSQL advisory lock BEFORE the already-returned quantities are read,
   * and the lock is held until commit. A second cashier returning the same line
   * therefore blocks, and once it proceeds it reads the first return's committed
   * rows and correctly rejects the over-return (it is not based on a stale
   * snapshot). Locks are taken in id order so overlapping returns cannot
   * deadlock, and 7 + 5 = 12 of a 10-unit line is impossible.
   *
   * This deliberately relies on the advisory lock rather than SERIALIZABLE
   * isolation: the lock already provides the mutual exclusion the check needs,
   * whereas SERIALIZABLE would additionally abort the loser with a write-conflict
   * retry error instead of the precise "exceeds returnable quantity" response.
   */
  async createReturn(
    saleId: string,
    input: CreateSaleReturnInput,
    actor: Pick<AuthenticatedUser, "id">,
  ) {
    if (input.items.length === 0) {
      throw new AppError(
        422,
        ErrorCode.RETURN_EMPTY,
        "A return must contain at least one item",
      );
    }

    // The same sale line must not appear twice in one request: the two entries
    // would race for the same "remaining returnable" pool and make the
    // expected total ambiguous.
    const requestedIds = input.items.map((item) => item.saleItemId);
    if (new Set(requestedIds).size !== requestedIds.length) {
      throw new AppError(
        422,
        ErrorCode.DUPLICATE_SALE_ITEM_IN_RETURN,
        "Each sale item may only appear once in a return",
      );
    }

    try {
      return await prisma.$transaction(
        async (tx) => {
          // 0. Idempotency: serialise on the key, then replay the original
          //    return instead of refunding and moving stock twice.
          if (input.idempotencyKey) {
            await lockAdvisory(tx, `saleReturnIdempotency:${input.idempotencyKey}`);
            const replay = await tx.saleReturn.findUnique({
              where: { idempotencyKey: input.idempotencyKey },
              include: saleReturnDetailInclude,
            });
            if (replay) {
              return replay;
            }
          }

          // 1. Load and validate the sale. Only a COMPLETED sale is returnable:
          //    a DRAFT sale never moved stock, and a CANCELLED one is already
          //    reversed by the void flow.
          const sale = await tx.sale.findUnique({
            where: { id: saleId },
            select: {
              id: true,
              saleNumber: true,
              status: true,
              locationId: true,
              subtotal: true,
              totalDiscount: true,
              totalAmount: true,
              location: { select: { id: true, name: true, isActive: true } },
            },
          });
          if (!sale) {
            throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
          }
          if (sale.status !== "COMPLETED") {
            throw new AppError(
              409,
              ErrorCode.SALE_NOT_RETURNABLE,
              `A ${sale.status.toLowerCase()} sale cannot be returned against`,
            );
          }

          // Stock is always restored to the ORIGINAL sale location — the
          // client cannot choose another one.
          if (!sale.location) {
            throw new AppError(
              404,
              ErrorCode.LOCATION_NOT_FOUND,
              "Location not found",
            );
          }

          // 2. Lock every requested sale line, in id order, before reading the
          //    already-returned quantities. Locks are taken in a stable order
          //    so two overlapping returns can never deadlock.
          const lockedIds = [...requestedIds].sort();
          for (const saleItemId of lockedIds) {
            await lockAdvisory(tx, `saleReturnItem:${saleItemId}`);
          }

          const saleItems = await tx.saleItem.findMany({
            where: { id: { in: lockedIds } },
            select: {
              id: true,
              saleId: true,
              productId: true,
              unitId: true,
              quantity: true,
              baseQuantity: true,
              conversionFactor: true,
              actualUnitPrice: true,
              lineTotal: true,
              batchAllocations: {
                select: { batchId: true, baseQuantity: true },
                orderBy: [{ createdAt: "asc" }, { batchId: "asc" }],
              },
            },
          });
          const saleItemsById = new Map(saleItems.map((item) => [item.id, item]));

          // 3. Every requested line must exist AND belong to this sale.
          for (const saleItemId of requestedIds) {
            const saleItem = saleItemsById.get(saleItemId);
            if (!saleItem) {
              throw new AppError(
                404,
                ErrorCode.SALE_ITEM_NOT_FOUND,
                "Sale item not found",
              );
            }
            if (saleItem.saleId !== sale.id) {
              throw new AppError(
                422,
                ErrorCode.SALE_ITEM_NOT_ON_SALE,
                "The sale item does not belong to this sale",
              );
            }
          }

          // 4. Already-returned state, read AFTER the locks are held.
          const aggregates = await aggregateReturned(tx, lockedIds);

          // 5. Validate quantities and price every requested line. This is the
          //    step that enforces totalReturnedQuantity <= originalSoldQuantity.
          type PricedLine = {
            saleItemId: string;
            productId: string;
            unitId: string;
            quantity: Prisma.Decimal;
            baseQuantity: Prisma.Decimal;
            unitPrice: Prisma.Decimal;
            netUnitPrice: Prisma.Decimal;
            refundAmount: Prisma.Decimal;
            restock: boolean;
            reason: string | null;
            quantityReturnableAfter: Prisma.Decimal;
            batchAllocations: Array<{
              batchId: string;
              baseQuantity: Prisma.Decimal;
              returnItemId: string | null;
            }>;
          };

          const pricedLines: PricedLine[] = [];
          let restockRequested = false;

          for (const item of input.items) {
            const saleItem = saleItemsById.get(item.saleItemId)!;
            const restock = item.restock ?? true;
            if (restock) {
              restockRequested = true;
            }

            const quantity = roundTo(toDecimal(item.quantity), STOCK_SCALE);
            const quantityAlreadyReturned =
              aggregates.quantityBySaleItem.get(saleItem.id) ??
              new Prisma.Decimal(0);
            const quantityReturnable = roundTo(
              Prisma.Decimal.max(saleItem.quantity.minus(quantityAlreadyReturned), 0),
              STOCK_SCALE,
            );

            if (quantity.gt(quantityReturnable)) {
              throw new AppError(
                422,
                ErrorCode.RETURN_QUANTITY_EXCEEDS_SOLD,
                quantityReturnable.lte(0)
                  ? "This sale item has already been fully returned"
                  : "The requested quantity exceeds the remaining returnable quantity",
                {
                  saleItemId: saleItem.id,
                  quantitySold: saleItem.quantity.toNumber(),
                  quantityAlreadyReturned: roundTo(quantityAlreadyReturned, STOCK_SCALE).toNumber(),
                  quantityReturnable: quantityReturnable.toNumber(),
                  quantityRequested: quantity.toNumber(),
                },
              );
            }

            // Normalize to base units with the SALE-TIME conversion factor
            // snapshot — never the product's current unit configuration.
            const baseQuantity = roundTo(
              quantity.mul(saleItem.conversionFactor),
              STOCK_SCALE,
            );

            // Refund from the ORIGINAL sale values only.
            const alreadyRefunded =
              aggregates.refundBySaleItem.get(saleItem.id) ?? new Prisma.Decimal(0);
            const netLineTotal = netLineTotalForItem(sale, saleItem);
            const refundAmount = refundAmountForQuantity({
              netLineTotal,
              quantitySold: saleItem.quantity,
              alreadyReturnedQuantity: quantityAlreadyReturned,
              alreadyRefunded,
              quantityReturning: quantity,
            });
            const netUnitPrice = netUnitPriceForItem(netLineTotal, saleItem.quantity);

            // Restock back into the ORIGINAL batches.
            let batchAllocations: Array<{
              batchId: string;
              baseQuantity: Prisma.Decimal;
              returnItemId: string | null;
            }> = [];
            if (restock) {
              const alreadyReturnedByBatch = new Map<string, Prisma.Decimal>();
              for (const original of saleItem.batchAllocations) {
                alreadyReturnedByBatch.set(
                  original.batchId,
                  aggregates.baseBySaleItemBatch.get(
                    batchAggregateKey(saleItem.id, original.batchId),
                  ) ?? new Prisma.Decimal(0),
                );
              }

              if (saleItem.batchAllocations.length === 0) {
                throw new AppError(
                  409,
                  ErrorCode.RETURN_BATCH_ALLOCATION_FAILED,
                  "This sale item has no batch allocation to restock into; return it as non-restockable",
                );
              }

              batchAllocations = allocateReturnToOriginalBatches({
                allocations: saleItem.batchAllocations,
                alreadyReturnedByBatch,
                requestedBaseQuantity: baseQuantity,
                // When the line is closed out, absorb sub-precision rounding
                // residue so a full return restores the full sold quantity.
                absorbsRoundingResidue: quantity.gte(quantityReturnable),
              }).map((allocation) => ({ ...allocation, returnItemId: null }));

              // An expired batch cannot receive stock through the movement
              // engine. Fail explicitly so the cashier can retry as
              // non-restockable instead of silently losing the refund or
              // silently restocking sellable expired goods.
              const batchIds = batchAllocations.map((a) => a.batchId);
              const expiredBatches = await tx.batch.findMany({
                where: { id: { in: batchIds } },
                select: { id: true, batchNumber: true, expiryDate: true },
              });
              const expired = expiredBatches.filter((batch) =>
                isExpired(batch.expiryDate),
              );
              if (expired.length > 0) {
                throw new AppError(
                  409,
                  ErrorCode.RETURN_BATCH_EXPIRED,
                  `Batch ${expired.map((b) => b.batchNumber).join(", ")} has expired and cannot be restocked. Retry with restock=false to refund without returning it to sellable stock.`,
                  { expiredBatches: expired.map((b) => ({ id: b.id, batchNumber: b.batchNumber })) },
                );
              }

              // Returning stock into an inactive location is rejected by the
              // movement engine; fail early with a clear message.
              if (!sale.location.isActive) {
                throw new AppError(
                  409,
                  ErrorCode.INACTIVE_LOCATION,
                  "The original sale location is inactive and cannot receive returned stock. Retry with restock=false to refund without restocking.",
                );
              }
            }

            pricedLines.push({
              saleItemId: saleItem.id,
              productId: saleItem.productId,
              unitId: saleItem.unitId,
              quantity,
              baseQuantity,
              unitPrice: saleItem.actualUnitPrice,
              netUnitPrice,
              refundAmount,
              restock,
              reason: item.reason ?? null,
              quantityReturnableAfter: roundTo(
                quantityReturnable.minus(quantity),
                STOCK_SCALE,
              ),
              batchAllocations,
            });
          }

          const refundTotal = pricedLines.reduce(
            (sum, line) => sum.plus(line.refundAmount),
            new Prisma.Decimal(0),
          );

          // 6. The return header, carrying the immediate refund. It is stored
          //    on the return (NOT on sale_payment/payment) so the original
          //    sale's payment history is never rewritten.
          const created = await tx.saleReturn.create({
            data: {
              returnNumber: generateReturnNumber(),
              saleId: sale.id,
              locationId: sale.locationId,
              refundAmount: refundTotal,
              refundMethod: input.refundMethod,
              refundReference: input.refundReference ?? null,
              reason: input.reason ?? null,
              notes: input.notes ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
              createdById: actor.id,
            },
          });

          // 7. Return items + batch splits + inventory, all in this transaction.
          for (const line of pricedLines) {
            const returnItem = await tx.saleReturnItem.create({
              data: {
                returnId: created.id,
                saleItemId: line.saleItemId,
                productId: line.productId,
                unitId: line.unitId,
                quantity: line.quantity,
                baseQuantity: line.baseQuantity,
                unitPrice: line.unitPrice,
                netUnitPrice: line.netUnitPrice,
                refundAmount: line.refundAmount,
                restock: line.restock,
                reason: line.reason,
              },
            });

            if (line.batchAllocations.length > 0) {
              await tx.saleReturnItemBatch.createMany({
                data: line.batchAllocations.map((allocation) => ({
                  saleReturnItemId: returnItem.id,
                  batchId: allocation.batchId,
                  baseQuantity: allocation.baseQuantity,
                })),
              });
              // Link the movements we are about to write to this exact return
              // item, so every stock movement traces back to the line it
              // restored.
              for (const allocation of line.batchAllocations) {
                allocation.returnItemId = returnItem.id;
              }
            }
          }

          // 8. Restore inventory through the central movement engine
          //    (RETURN_IN / IN), which re-validates under the per-(batch,
          //    location) advisory lock. Movements are applied in batchId order
          //    so concurrent returns/sales on the same batches cannot deadlock.
          if (restockRequested) {
            const movements = pricedLines
              .flatMap((line) =>
                line.batchAllocations.map((allocation) => {
                  const saleItem = saleItemsById.get(line.saleItemId)!;
                  return {
                    productId: line.productId,
                    batchId: allocation.batchId,
                    baseQuantity: allocation.baseQuantity,
                    conversionFactor: saleItem.conversionFactor,
                    unitId: line.unitId,
                    returnItemId: allocation.returnItemId!,
                  };
                }),
              )
              .sort((a, b) => a.batchId.localeCompare(b.batchId));

            for (const movement of movements) {
              await recordMovementInTransaction(tx, {
                productId: movement.productId,
                batchId: movement.batchId,
                locationId: sale.locationId,
                transactionType: "RETURN_IN",
                direction: "IN",
                quantity: movement.baseQuantity,
                // Sale-time conversion snapshot, for ledger traceability.
                unitId: movement.unitId,
                conversionFactor: movement.conversionFactor,
                referenceType: "SaleReturnItem",
                referenceId: movement.returnItemId,
                notes: `Customer return ${created.returnNumber} against sale ${sale.saleNumber}`,
                actor,
              });
            }
          }

          // 9. Audit inside the same transaction: a rolled-back return never
          //    claims to have refunded money or moved stock.
          await recordAuditEvent(
            {
              event: AuditEvent.SALE_RETURN_CREATED,
              entityId: created.id,
              actorId: actor.id,
              metadata: {
                returnNumber: created.returnNumber,
                saleId: sale.id,
                saleNumber: sale.saleNumber,
                locationId: sale.locationId,
                refundAmount: refundTotal.toNumber(),
                refundMethod: created.refundMethod,
                itemCount: pricedLines.length,
                restockedItemCount: pricedLines.filter((line) => line.restock).length,
                items: pricedLines.map((line) => ({
                  saleItemId: line.saleItemId,
                  quantity: line.quantity.toNumber(),
                  refundAmount: line.refundAmount.toNumber(),
                  restock: line.restock,
                })),
              },
            },
            tx,
          );

          return await tx.saleReturn.findUniqueOrThrow({
            where: { id: created.id },
            include: saleReturnDetailInclude,
          });
        },
        {
          maxWait: 15_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      // A write conflict between concurrent returns on the same sale item, or
      // an idempotency-key race: nothing was committed, so a retry is safe.
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034") {
          throw new AppError(
            409,
            ErrorCode.CONFLICT,
            "Concurrent return detected — please retry",
          );
        }
        if (
          error.code === "P2002" &&
          input.idempotencyKey !== undefined
        ) {
          throw new AppError(
            409,
            ErrorCode.CONFLICT,
            "A return with this idempotency key already exists",
          );
        }
      }
      throw error;
    }
  },
};