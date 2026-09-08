import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

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
  totalStock: number;
  selectedLocationStock: number | null;
  nearestExpiry: Date | null;
  stockStatus: StockStatus;
};

export type InventoryProductListQuery = PageQuery & {
  search?: string;
  productGroupId?: string;
  brand?: string;
  locationId?: string;
  stockStatus?: StockStatus;
  isActive?: boolean;
};

function calculateStockStatus(
  totalStock: number,
  minimumStock: Prisma.Decimal,
  reorderPoint: Prisma.Decimal | null,
): StockStatus {
  if (totalStock <= 0) {
    return "OUT_OF_STOCK";
  }
  const minStock = minimumStock.toNumber();
  const reorderPt = reorderPoint?.toNumber() ?? minStock;
  if (totalStock <= reorderPt) {
    return "LOW_STOCK";
  }
  return "IN_STOCK";
}

export const inventoryProductService = {
  async list(query: InventoryProductListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

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

    // If filtering by stockStatus, we need to filter after aggregation
    // For locationId filter, we'll need to join with inventory stock

    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          genericName: true,
          brand: true,
          sku: true,
          productGroup: { select: { id: true, name: true } },
          isActive: true,
          minimumStock: true,
          reorderPoint: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.product.count({ where }),
    ]);

    const productIds = products.map((p) => p.id);

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
    if (query.locationId) {
      const locationStock = await prisma.inventoryStock.findMany({
        where: {
          productId: { in: productIds },
          locationId: query.locationId,
          quantity: { gt: 0 },
        },
        select: { productId: true, quantity: true },
      });
      selectedLocationStockMap = new Map(
        locationStock.map((row) => [row.productId, row.quantity.toNumber()]),
      );
    }

    // Get nearest expiry per product
    const nearestExpiry = await prisma.batch.findMany({
      where: {
        productId: { in: productIds },
        expiryDate: { gte: new Date() },
        stock: { some: { quantity: { gt: 0 } } },
      },
      select: {
        productId: true,
        expiryDate: true,
      },
      orderBy: { expiryDate: "asc" },
      distinct: ["productId"],
    });
    const nearestExpiryMap = new Map(
      nearestExpiry.map((row) => [row.productId, row.expiryDate]),
    );

    // Build items with inventory data
    let items: InventoryProductItem[] = products.map((product) => {
      const totalStock = totalStockMap.get(product.id) ?? 0;
      const selectedLocationStock = selectedLocationStockMap.get(product.id) ?? null;
      const stockStatus = calculateStockStatus(
        totalStock,
        product.minimumStock,
        product.reorderPoint,
      );

      return {
        ...product,
        totalStock,
        selectedLocationStock,
        nearestExpiry: nearestExpiryMap.get(product.id) ?? null,
        stockStatus,
      };
    });

    // Filter by stockStatus if provided
    if (query.stockStatus) {
      items = items.filter((item) => item.stockStatus === query.stockStatus);
    }

    // Note: When filtering by stockStatus, the total count may not match exactly
    // This is a limitation of post-aggregation filtering
    const meta = buildPaginationMeta(items.length, page, limit);

    return { items, meta };
  },
};