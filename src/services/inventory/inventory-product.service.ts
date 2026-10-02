import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import {
  pricingService,
  type PricingStatusFilter,
  type ProductPricing,
} from "./pricing.service.js";

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export type InventoryProductItem = {
  id: string;
  name: string;
  genericName: string | null;
  brand: string | null;
  sku: string;
  productGroup: { id: string; name: string } | null;
  isActive: boolean;
  minimumStock: Prisma.Decimal;
  reorderPoint: Prisma.Decimal | null;
  baseUnit: { id: string; name: string; symbol: string | null } | null;
  totalStock: number;
  selectedLocationStock: number | null;
  nearestExpiry: {
    batchId: string;
    batchNumber: string;
    expiryDate: Date;
    quantity: number;
  } | null;
  stockStatus: StockStatus;
  /**
   * Read-only pricing / target-margin warning. Never reprices the product; see
   * pricing.service.ts for the sources of truth and the status precedence.
   */
  pricing: ProductPricing | null;
};

export type InventoryProductListQuery = PageQuery & {
  search?: string;
  productGroupId?: string;
  brand?: string;
  locationId?: string;
  stockStatus?: StockStatus;
  isActive?: boolean;
  pricingStatus?: PricingStatusFilter;
};

export function calculateStockStatus(
  totalStock: number,
  minimumStock: Prisma.Decimal,
  reorderPoint: Prisma.Decimal | null,
): StockStatus {
  if (totalStock <= 0) {
    return "OUT_OF_STOCK";
  }
  const minStock = minimumStock.toNumber();
  const effectiveThreshold = reorderPoint?.toNumber() ?? minStock;
  if (totalStock <= effectiveThreshold) {
    return "LOW_STOCK";
  }
  return "IN_STOCK";
}

/**
 * The product columns this endpoint returns. Shared by both the plain and the
 * pricing-filtered path so the two never drift apart.
 */
const INVENTORY_PRODUCT_SELECT = {
  id: true,
  name: true,
  genericName: true,
  brand: true,
  sku: true,
  productGroup: { select: { id: true, name: true } },
  isActive: true,
  minimumStock: true,
  reorderPoint: true,
  units: {
    where: { isBaseUnit: true },
    take: 1,
    select: {
      unit: { select: { id: true, name: true, symbol: true } },
    },
  },
} satisfies Prisma.ProductSelect;

type InventoryProductRow = Prisma.ProductGetPayload<{
  select: typeof INVENTORY_PRODUCT_SELECT;
}>;

/**
 * Attaches the aggregated inventory facts (total stock, selected-location stock,
 * nearest expiry, stock status) and the pricing warning to one page of products.
 *
 * Kept separate from the query so the plain list and the pricing-status filtered
 * list share exactly one implementation.
 */
async function hydrateProducts(params: {
  products: InventoryProductRow[];
  locationId?: string;
  pricingById: Map<string, ProductPricing>;
}): Promise<InventoryProductItem[]> {
  const { products, locationId, pricingById } = params;
  const productIds = products.map((p) => p.id);

  if (productIds.length === 0) {
    return [];
  }

  // Get total stock per product
  const totalStockAgg = await prisma.inventoryStock.groupBy({
    by: ["productId"],
    where: {
      productId: { in: productIds },
      quantity: { gt: 0 },
    },
    _sum: { quantity: true },
  });
  const totalStockMap = new Map(
    totalStockAgg.map((row) => [row.productId, row._sum.quantity?.toNumber() ?? 0]),
  );

  // Get selected location stock per product if locationId provided
  let selectedLocationStockMap = new Map<string, number>();
  if (locationId) {
    const locationStock = await prisma.inventoryStock.findMany({
      where: {
        productId: { in: productIds },
        locationId,
        quantity: { gt: 0 },
      },
      select: { productId: true, quantity: true },
    });
    selectedLocationStockMap = new Map(
      locationStock.map((row) => [row.productId, row.quantity.toNumber()]),
    );
  }

  // Get nearest expiry per product
  // Note: since we need stock quantity as well, we fetch batches with their stock sum
  // For simplicity, we just fetch the batch that expires soonest and its total stock
  const nearestExpiry = await prisma.batch.findMany({
    where: {
      productId: { in: productIds },
      expiryDate: { gte: new Date() },
      stock: { some: { quantity: { gt: 0 } } },
    },
    select: {
      id: true,
      productId: true,
      batchNumber: true,
      expiryDate: true,
      stock: {
        select: { quantity: true },
      },
    },
    orderBy: { expiryDate: "asc" },
  });

  // Process nearest expiry to get only the first one per product and sum its stock
  const nearestExpiryMap = new Map<string, { batchId: string; batchNumber: string; expiryDate: Date; quantity: number }>();
  for (const batch of nearestExpiry) {
    if (!nearestExpiryMap.has(batch.productId)) {
      const batchQuantity = batch.stock.reduce((sum, s) => sum + s.quantity.toNumber(), 0);
      if (batchQuantity > 0) {
        nearestExpiryMap.set(batch.productId, {
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantity: batchQuantity,
        });
      }
    }
  }

  return products.map((product) => {
    const totalStock = totalStockMap.get(product.id) ?? 0;
    const selectedLocationStock = selectedLocationStockMap.get(product.id) ?? null;
    const stockStatus = calculateStockStatus(
      totalStock,
      product.minimumStock,
      product.reorderPoint,
    );

    const baseUnit = product.units[0]?.unit ?? null;
    return {
      id: product.id,
      name: product.name,
      genericName: product.genericName,
      brand: product.brand,
      sku: product.sku,
      productGroup: product.productGroup,
      isActive: product.isActive,
      minimumStock: product.minimumStock,
      reorderPoint: product.reorderPoint,
      baseUnit,
      totalStock,
      selectedLocationStock,
      nearestExpiry: nearestExpiryMap.get(product.id) ?? null,
      stockStatus,
      pricing: pricingById.get(product.id) ?? null,
    };
  });
}

export const inventoryProductService = {
  async list(query: InventoryProductListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const pricingStatus =
      query.pricingStatus && query.pricingStatus !== "ALL" ? query.pricingStatus : undefined;

    if (pricingStatus) {
      // Pricing-status filtered list: the filter, the count and the pagination
      // all happen in the DATABASE (see pricing.service.ts), then only the
      // requested page is hydrated. Never fetch-then-filter-then-paginate in
      // JavaScript, or the page would be half-empty and paging would skip rows.
      const { ids, total } = await pricingService.listProductIdsByPricingStatus({
        status: pricingStatus,
        filters: {
          search: query.search,
          productGroupId: query.productGroupId,
          brand: query.brand,
          isActive: query.isActive,
        },
        skip,
        take,
      });

      const rows =
        ids.length === 0
          ? []
          : await prisma.product.findMany({
              where: { id: { in: ids } },
              select: INVENTORY_PRODUCT_SELECT,
            });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      // Preserve the database's page order instead of findMany's arbitrary one.
      const orderedRows = ids.flatMap((id) => {
        const row = rowById.get(id);
        return row ? [row] : [];
      });

      const pricing = await pricingService.pricingForProductIds(ids);
      let items = await hydrateProducts({
        products: orderedRows,
        locationId: query.locationId,
        pricingById: pricing,
      });
      if (query.stockStatus) {
        items = items.filter((item) => item.stockStatus === query.stockStatus);
      }

      return { items, meta: buildPaginationMeta(total, page, limit) };
    }

    // Build where clause for products
    const where: Prisma.ProductWhereInput = {
      ...(query.productGroupId ? { productGroupId: query.productGroupId } : {}),
      ...(query.brand ? { brand: { equals: query.brand, mode: "insensitive" as const } } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              { genericName: { contains: query.search, mode: "insensitive" as const } },
              { brand: { contains: query.search, mode: "insensitive" as const } },
              { sku: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: INVENTORY_PRODUCT_SELECT,
        // The id tiebreaker matches the pricing-filtered path and keeps offset
        // paging stable when several products share a createdAt.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      // The real filtered count. It was previously discarded, which made
      // meta.total the page length and totalPages wrong for every request.
      prisma.product.count({ where }),
    ]);

    const pricingById = await pricingService.pricingForProductIds(
      products.map((product) => product.id),
    );

    let items = await hydrateProducts({
      products,
      locationId: query.locationId,
      pricingById,
    });

    // NOTE: `stockStatus` depends on aggregated stock, so it is still applied
    // after aggregation. This is a pre-existing limitation: combined with
    // stockStatus the returned page can be shorter than `limit` and meta.total
    // counts the pre-stockStatus dataset. `pricingStatus` above does NOT have
    // this problem because it is filtered in the database before pagination.
    if (query.stockStatus) {
      items = items.filter((item) => item.stockStatus === query.stockStatus);
    }

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};