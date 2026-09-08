import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type LocationStockQuery = PageQuery & {
  locationId?: string;
  productId?: string;
  search?: string;
};

export type LocationStockItem = {
  product: {
    id: string;
    name: string;
    genericName: string | null;
    brand: string | null;
    sku: string;
    productGroup: { id: string; name: string } | null;
  };
  locations: Array<{
    locationId: string;
    locationName: string;
    quantity: number;
  }>;
  totalQuantity: number;
};

export const locationStockService = {
  async list(query: LocationStockQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    // Get products with their stock
    const productWhere: Prisma.ProductWhereInput = {
      ...(query.productId ? { id: query.productId } : {}),
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
      isActive: true,
    };

    const products = await prisma.product.findMany({
      where: productWhere,
      select: {
        id: true,
        name: true,
        genericName: true,
        brand: true,
        sku: true,
        productGroup: { select: { id: true, name: true } },
      },
      orderBy: { name: "asc" },
      skip,
      take,
    });

    const productIds = products.map((p) => p.id);

    // Get stock grouped by product and location
    const stockWhere: Prisma.InventoryStockWhereInput = {
      productId: { in: productIds },
      quantity: { gt: 0 },
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };

    const stockRows = await prisma.inventoryStock.groupBy({
      by: ["productId", "locationId"],
      where: stockWhere,
      _sum: { quantity: true },
    });

    // Get location names
    const locationIds = [...new Set(stockRows.map((row) => row.locationId))];
    const locations = await prisma.inventoryLocation.findMany({
      where: { id: { in: locationIds } },
      select: { id: true, name: true },
    });
    const locationNames = new Map(locations.map((loc) => [loc.id, loc.name]));

    // Build location stock map
    const stockByProduct = new Map<string, Map<string, number>>();
    for (const row of stockRows) {
      if (!stockByProduct.has(row.productId)) {
        stockByProduct.set(row.productId, new Map());
      }
      stockByProduct.get(row.productId)!.set(row.locationId, row._sum.quantity?.toNumber() ?? 0);
    }

    // Get all active locations for consistent output (if not filtering by location)
    const allLocations = query.locationId
      ? locations
      : await prisma.inventoryLocation.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        });

    // Build items
    const items: LocationStockItem[] = products.map((product) => {
      const productStockMap = stockByProduct.get(product.id) ?? new Map();
      const locationsData = allLocations
        .map((loc) => ({
          locationId: loc.id,
          locationName: loc.name,
          quantity: productStockMap.get(loc.id) ?? 0,
        }))
        .filter((loc) => loc.quantity > 0 || query.locationId); // Show all locations if filtering by location

      const totalQuantity = locationsData.reduce((sum, loc) => sum + loc.quantity, 0);

      return {
        product,
        locations: locationsData,
        totalQuantity,
      };
    });

    const total = await prisma.product.count({ where: productWhere });
    const meta = buildPaginationMeta(total, page, limit);

    return { items, meta };
  },
};