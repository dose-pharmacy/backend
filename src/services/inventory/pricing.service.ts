import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";

/**
 * Product pricing / target-margin warning.
 *
 * This is a WARNING layer only — it never writes anything and never reprices a
 * product. It answers one question for the product detail page and the product
 * list:
 *
 *   "Does the current selling price reach the target price implied by the
 *    product group's configured profit margin and the cost we actually paid?"
 *
 * Sources of truth (see the accompanying report):
 *  - selling price .......... base ProductUnit.sellPrice (per base unit)
 *  - target margin .......... ProductGroup.defaultProfitMargin (PERCENT 0-100)
 *  - cost basis ............. highest received purchase cost, converted to the
 *                             base unit, over CONFIRMED goods receipts of
 *                             non-cancelled purchase orders
 *
 * Margin is a MARGIN ON SELLING PRICE:
 *
 *   targetSellingPrice = costBasis / (1 - targetMargin / 100)
 *
 * Conventions:
 *  - `targetMargin` is exposed as the project's percentage convention (10 means
 *    10%), matching ProductGroup.defaultProfitMargin and the product-group API.
 *  - every monetary value is a Prisma.Decimal so serialization keeps the
 *    project's precision rules; the only rounding applied is the presentation
 *    rounding of `targetSellingPrice` (2 dp, half-up).
 *
 * The classification below (`computeProductPricing`) is the single source of
 * truth for the API response. `pricingStatusPredicateSql` is its exact SQL
 * mirror, used only so the product list can FILTER on the status inside the
 * database (before pagination); `tests/pricing.unit.test.ts` and the pricing
 * integration suite assert both agree.
 */

export const PRICING_STATUSES = [
  "OK",
  "BELOW_TARGET",
  "BELOW_COST",
  "NO_MARGIN_CONFIG",
  "NO_PURCHASE_COST",
] as const;

export type PricingStatus = (typeof PRICING_STATUSES)[number];

/** Values accepted by the product list `pricingStatus` query filter. */
export const PRICING_STATUS_FILTER_VALUES = [
  "ALL",
  ...PRICING_STATUSES,
] as const;

export type PricingStatusFilter = (typeof PRICING_STATUS_FILTER_VALUES)[number];

/**
 * Margin bounds. ProductGroup.defaultProfitMargin is DECIMAL(5,2) and may hold
 * anything from 0 to 999.99, but only a strictly positive margin below 100%
 * produces a usable target price (100% would imply an infinite price). Anything
 * outside that range is reported as NO_MARGIN_CONFIG instead of fabricating a
 * margin — and a group left at the column default of 0 counts as "not
 * configured".
 */
const MIN_USABLE_MARGIN_PERCENT = toDecimal(0);
const MAX_USABLE_MARGIN_PERCENT = toDecimal(100);
const PERCENT = toDecimal(100);
const ZERO = toDecimal(0);

export type ProductPricing = {
  /** Current base-unit selling price (ProductUnit.sellPrice). Null = unpriced. */
  sellingPrice: Prisma.Decimal | null;
  /** Product group target profit margin, as a percentage (10 = 10%). */
  targetMargin: Prisma.Decimal | null;
  /** Highest received purchase cost, converted to the base unit. */
  costBasis: Prisma.Decimal | null;
  /** Selling price required to hit the target margin. Null when not computable. */
  targetSellingPrice: Prisma.Decimal | null;
  pricingStatus: PricingStatus;
};

/** Numeric values coming back from $queryRaw are numeric/Decimal-ish. */
function decimalOrNull(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return toDecimal(value as number | string);
}

/**
 * The one and only pricing-warning calculation.
 *
 * Precedence (deliberate):
 *  1. NO_MARGIN_CONFIG — no usable product-group target margin.
 *  2. NO_PURCHASE_COST — no valid received purchase cost to compare against.
 *  3. BELOW_COST       — selling price <= cost basis (takes precedence over
 *                        BELOW_TARGET: the product does not even cover cost).
 *  4. OK               — selling price >= target selling price.
 *  5. BELOW_TARGET     — above cost but short of the configured target margin.
 *
 * An unpriced product (no base unit / no sellPrice) is treated as selling at 0,
 * so it is reported BELOW_COST (it cannot cover any known cost) rather than
 * silently OK. `sellingPrice` stays null in the payload so clients can tell the
 * difference.
 */
export function computeProductPricing(input: {
  sellingPrice: Prisma.Decimal | null;
  targetMargin: Prisma.Decimal | null;
  costBasis: Prisma.Decimal | null;
}): ProductPricing {
  const { sellingPrice, targetMargin, costBasis } = input;

  const hasUsableMargin =
    targetMargin !== null &&
    targetMargin.gt(MIN_USABLE_MARGIN_PERCENT) &&
    targetMargin.lt(MAX_USABLE_MARGIN_PERCENT);

  if (!hasUsableMargin) {
    return {
      sellingPrice,
      targetMargin,
      costBasis,
      targetSellingPrice: null,
      pricingStatus: "NO_MARGIN_CONFIG",
    };
  }

  if (costBasis === null) {
    return {
      sellingPrice,
      targetMargin,
      costBasis: null,
      targetSellingPrice: null,
      pricingStatus: "NO_PURCHASE_COST",
    };
  }

  // margin-on-selling-price: cost / (1 - margin)
  const denominator = ZERO.add(1).sub(targetMargin.div(PERCENT));
  const targetSellingPrice = roundTo(costBasis.div(denominator), 2);

  const effectiveSellingPrice = sellingPrice ?? ZERO;

  let pricingStatus: PricingStatus;
  if (effectiveSellingPrice.lte(costBasis)) {
    pricingStatus = "BELOW_COST";
  } else if (effectiveSellingPrice.gte(targetSellingPrice)) {
    pricingStatus = "OK";
  } else {
    pricingStatus = "BELOW_TARGET";
  }

  return {
    sellingPrice,
    targetMargin,
    costBasis,
    targetSellingPrice,
    pricingStatus,
  };
}

// ---------------------------------------------------------------------------
// Database-side pricing
// ---------------------------------------------------------------------------

type PricingRow = {
  product_id: string;
  selling_price: unknown;
  target_margin: unknown;
  cost_basis: unknown;
};

/**
 * Cost basis aggregate: for every product, the HIGHEST received unit cost
 * expressed in BASE units.
 *
 * Source rows are goods receipt lines (the authoritative "we actually received
 * this" record) joined to their purchase order so cancelled orders are excluded
 * and to the PO item so the ordered-unit snapshot can convert the ordered-unit
 * price into the base unit the selling price is compared in:
 *
 *   baseCost = unitCost / (quantityOrderedBase / quantityOrdered)
 *            = unitCost * quantityOrdered / quantityOrderedBase
 *
 * Only CONFIRMED receipts (`confirmedById IS NOT NULL`) with a positive received
 * quantity count; planned PO prices, invoice totals and PO totals never do.
 * Legacy PO items without a base snapshot fall back to factor 1 (interpreted as
 * base units), exactly like the stock movement engine does.
 *
 * Batch purchase costs are read, never written or normalized.
 *
 * NOTE: no artificial recency window is applied — every confirmed receipt
 * counts. Introduce a window here (not at the call sites) if "recent" should
 * later mean e.g. the last 12 months.
 */
function costBasisAggregateSql(productIds?: string[]): Prisma.Sql {
  const restrict =
    productIds && productIds.length > 0
      ? Prisma.sql`AND poi."productId" IN (${Prisma.join(productIds)})`
      : Prisma.empty;
  return Prisma.sql`
    SELECT poi."productId" AS product_id,
           MAX(
             gri."unitCost" * CASE
               WHEN poi."quantityOrderedBase" > 0
                 THEN poi."quantityOrdered" / poi."quantityOrderedBase"
               ELSE 1
             END
           ) AS cost_basis
    FROM goods_receipt_item gri
    JOIN goods_receipt gr ON gr.id = gri."goodsReceiptId"
    JOIN purchase_order po ON po.id = gr."purchaseOrderId"
    JOIN purchase_order_item poi ON poi.id = gri."purchaseOrderItemId"
    WHERE gr."confirmedById" IS NOT NULL
      AND gri."actualQty" > 0
      AND po.status <> 'CANCELLED'
      ${restrict}
    GROUP BY poi."productId"`;
}

/** Base-unit selling price of a product (mirrors Prisma's `isBaseUnit` lookup). */
const sellingPriceSql = Prisma.sql`(
  SELECT pu."sellPrice"
  FROM product_unit pu
  WHERE pu."productId" = p.id AND pu."isBaseUnit" = true
  ORDER BY pu."createdAt" ASC
  LIMIT 1
)`;

/**
 * Resolves the FULL pricing warning (including the classification) for a set of
 * products. One query per call, no matter how many products are asked for, so
 * the product list stays a bounded number of round-trips (no N+1).
 */
export async function pricingForProductIds(
  productIds: string[],
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, ProductPricing>> {
  const result = new Map<string, ProductPricing>();
  if (productIds.length === 0) {
    return result;
  }

  const rows = await client.$queryRaw<PricingRow[]>(Prisma.sql`
    SELECT p.id AS product_id,
           ${sellingPriceSql} AS selling_price,
           pg."defaultProfitMargin" AS target_margin,
           agg.cost_basis AS cost_basis
    FROM product p
    JOIN product_group pg ON pg.id = p."productGroupId"
    LEFT JOIN (${costBasisAggregateSql(productIds)}) agg ON agg.product_id = p.id
    WHERE p.id IN (${Prisma.join(productIds)})
  `);

  for (const row of rows) {
    result.set(
      row.product_id,
      computeProductPricing({
        sellingPrice: decimalOrNull(row.selling_price),
        targetMargin: decimalOrNull(row.target_margin),
        costBasis: decimalOrNull(row.cost_basis),
      }),
    );
  }
  return result;
}

export type PricingListFilters = {
  search?: string;
  productGroupId?: string;
  brand?: string;
  isActive?: boolean;
};

/**
 * The product-list legacy filters, mirrored as parameterized SQL so the pricing
 * status can be evaluated in the same query as the filters (kept in sync with
 * productRepository.list with `tests/product-pricing.integration.test.ts`).
 */
function pricingBaseFiltersSql(filters: PricingListFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  if (filters.productGroupId) {
    clauses.push(Prisma.sql`p."productGroupId" = ${filters.productGroupId}`);
  }
  if (filters.brand) {
    clauses.push(Prisma.sql`p.brand ILIKE ${filters.brand}`);
  }
  if (filters.isActive !== undefined) {
    clauses.push(Prisma.sql`p."isActive" = ${filters.isActive}`);
  }
  if (filters.search) {
    const needle = `%${filters.search}%`;
    clauses.push(
      Prisma.sql`(
        p.name ILIKE ${needle}
        OR p."genericName" ILIKE ${needle}
        OR p.brand ILIKE ${needle}
        OR p.sku ILIKE ${needle}
      )`,
    );
  }

  if (clauses.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.join(clauses, " AND ");
}

/**
 * SQL mirror of `computeProductPricing`'s classification, so the pricing status
 * can be filtered in the DATABASE before pagination.
 */
function pricingStatusPredicateSql(status: PricingStatus): Prisma.Sql {
  return Prisma.sql`
    CASE
      WHEN target_margin IS NULL
        OR target_margin <= 0
        OR target_margin >= 100
        THEN 'NO_MARGIN_CONFIG'
      WHEN cost_basis IS NULL THEN 'NO_PURCHASE_COST'
      WHEN COALESCE(selling_price, 0) <= cost_basis THEN 'BELOW_COST'
      WHEN COALESCE(selling_price, 0) >= ROUND(cost_basis / (1 - target_margin / 100), 2) THEN 'OK'
      ELSE 'BELOW_TARGET'
    END = ${status}
  `;
}

type PricedProductRow = {
  id: string;
  is_active: boolean;
  product_group_id: string;
};

/**
 * Every product with its pricing inputs, already narrowed to one pricing
 * status. Wrapped by the three list queries below so filtering, counting and
 * summarizing all share the same definition.
 */
function pricedProductsSql(
  status: PricingStatus,
  filters: PricingListFilters,
): Prisma.Sql {
  return Prisma.sql`
    SELECT p.id,
           p."createdAt" AS created_at,
           p."isActive" AS is_active,
           p."productGroupId" AS product_group_id,
           pg."defaultProfitMargin" AS target_margin,
           ${sellingPriceSql} AS selling_price,
           agg.cost_basis AS cost_basis
    FROM product p
    JOIN product_group pg ON pg.id = p."productGroupId"
    LEFT JOIN (${costBasisAggregateSql()}) agg ON agg.product_id = p.id
    WHERE ${pricingBaseFiltersSql(filters)}
  `;
}

/**
 * One page of product ids matching a pricing status, filtered AND paginated in
 * the database. Ordering mirrors the product list (`createdAt DESC` with the id
 * as a stable tiebreaker so paging never skips or repeats a row).
 */
export async function listProductIdsByPricingStatus(params: {
  status: PricingStatus;
  filters: PricingListFilters;
  skip: number;
  take: number;
}): Promise<{ ids: string[]; total: number }> {
  const { status, filters, skip, take } = params;
  const priced = pricedProductsSql(status, filters);
  const predicate = pricingStatusPredicateSql(status);

  const [pageRows, totalRows] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH priced AS (${priced})
      SELECT id FROM priced WHERE ${predicate}
      ORDER BY created_at DESC, id DESC
      LIMIT ${take} OFFSET ${skip}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      WITH priced AS (${priced})
      SELECT COUNT(*)::int AS total FROM priced WHERE ${predicate}
    `),
  ]);

  return {
    ids: pageRows.map((row) => row.id),
    total: totalRows[0]?.total ?? 0,
  };
}

/**
 * Summary counts (active/inactive + per product group) over the pricing-filtered
 * dataset, so the list summary never contradicts the filtered page.
 */
export async function summarizeByPricingStatus(params: {
  status: PricingStatus;
  filters: PricingListFilters;
}): Promise<{
  byStatus: { active: number; inactive: number };
  byProductGroup: { productGroupId: string; count: number }[];
}> {
  const { status, filters } = params;
  const rows = await prisma.$queryRaw<
    (PricedProductRow & { count: number })[]
  >(Prisma.sql`
    WITH priced AS (${pricedProductsSql(status, filters)})
    SELECT is_active, product_group_id, COUNT(*)::int AS count
    FROM priced WHERE ${pricingStatusPredicateSql(status)}
    GROUP BY is_active, product_group_id
  `);

  const byStatus = { active: 0, inactive: 0 };
  const groupCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.is_active) {
      byStatus.active += row.count;
    } else {
      byStatus.inactive += row.count;
    }
    groupCounts.set(
      row.product_group_id,
      (groupCounts.get(row.product_group_id) ?? 0) + row.count,
    );
  }

  return {
    byStatus,
    byProductGroup: [...groupCounts.entries()]
      .map(([productGroupId, count]) => ({ productGroupId, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export const pricingService = {
  computeProductPricing,
  pricingForProductIds,
  listProductIdsByPricingStatus,
  summarizeByPricingStatus,
};
