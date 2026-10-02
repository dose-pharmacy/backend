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
      query.pricingStatus && query.pricingStatus !== "ALL"
        ? query.pricingStatus
        : undefined;

    /**
     * ============================================================
     * PRICING STATUS FILTER
     * ============================================================
     *
     * pricingStatus is calculated by pricingService, so the
     * filtering + counting + pagination must happen there.
     *
     * We only hydrate the IDs belonging to the requested page.
     */
    if (pricingStatus) {
      const { ids, total } =
        await pricingService.listProductIdsByPricingStatus({
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

      if (ids.length === 0) {
        return {
          items: [],
          meta: buildPaginationMeta(total, page, limit),
        };
      }

      const products = await prisma.product.findMany({
        where: {
          id: {
            in: ids,
          },
        },
        select: INVENTORY_PRODUCT_SELECT,
      });

      /**
       * Prisma `findMany({ id: { in: ids } })` does not guarantee
       * that the returned rows have the same order as `ids`.
       *
       * Rebuild the original order explicitly.
       */
      const productById = new Map(
        products.map((product) => [product.id, product]),
      );

      const orderedProducts = ids.flatMap((id) => {
        const product = productById.get(id);

        return product ? [product] : [];
      });

      const pricingById =
        await pricingService.pricingForProductIds(ids);

      let items = await hydrateProducts({
        products: orderedProducts,
        locationId: query.locationId,
        pricingById,
      });

      /**
       * IMPORTANT:
       *
       * stockStatus is calculated from aggregated stock inside
       * hydrateProducts(), so it cannot currently participate in
       * the database-level pagination above.
       *
       * Therefore this filter can make the current page shorter.
       */
      if (query.stockStatus) {
        items = items.filter(
          (item) => item.stockStatus === query.stockStatus,
        );
      }

      return {
        items,
        meta: buildPaginationMeta(total, page, limit),
      };
    }

    /**
     * ============================================================
     * NORMAL PRODUCT LIST
     * ============================================================
     */

    const where: Prisma.ProductWhereInput = {
      ...(query.productGroupId
        ? {
            productGroupId: query.productGroupId,
          }
        : {}),

      ...(query.brand
        ? {
            brand: {
              equals: query.brand,
              mode: "insensitive" as const,
            },
          }
        : {}),

      ...(query.isActive !== undefined
        ? {
            isActive: query.isActive,
          }
        : {}),

      ...(query.search
        ? {
            OR: [
              {
                name: {
                  contains: query.search,
                  mode: "insensitive" as const,
                },
              },
              {
                genericName: {
                  contains: query.search,
                  mode: "insensitive" as const,
                },
              },
              {
                brand: {
                  contains: query.search,
                  mode: "insensitive" as const,
                },
              },
              {
                sku: {
                  contains: query.search,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
    };

    /**
     * IMPORTANT:
     *
     * `products` contains only the requested page.
     *
     * `total` contains the number of ALL products matching `where`.
     *
     * Pagination metadata MUST use `total`, not
     * `products.length`.
     */
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: INVENTORY_PRODUCT_SELECT,

        /**
         * Stable ordering is important for offset pagination.
         *
         * createdAt alone is not guaranteed to be unique.
         * Adding id gives us a deterministic tiebreaker.
         */
        orderBy: [
          {
            createdAt: "desc",
          },
          {
            id: "desc",
          },
        ],

        skip,
        take,
      }),

      /**
       * This is the REAL count of products matching the filters.
       *
       * Do NOT use products.length here.
       */
      prisma.product.count({
        where,
      }),
    ]);

    /**
     * Get pricing only for products on the current page.
     */
    const pricingById =
      await pricingService.pricingForProductIds(
        products.map((product) => product.id),
      );

    let items = await hydrateProducts({
      products,
      locationId: query.locationId,
      pricingById,
    });

    /**
     * stockStatus is derived from aggregated stock, so it is
     * currently filtered after hydration.
     *
     * This means stockStatus + pagination is not fully database-
     * paginated yet.
     */
    if (query.stockStatus) {
      items = items.filter(
        (item) => item.stockStatus === query.stockStatus,
      );
    }

    /**
     * VERY IMPORTANT:
     *
     * Use `total`, not `items.length` and not `products.length`.
     *
     * Example:
     *   total = 47
     *   limit = 10
     *
     * => totalPages = 5
     *
     * Even though page 1 only contains 10 items.
     */
    return {
      items,
      meta: buildPaginationMeta(total, page, limit),
    };
  },
};