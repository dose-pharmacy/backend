import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

export type StockListQuery = {
  productId?: string;
  batchId?: string;
  locationId?: string;
  search?: string;
  skip: number;
  take: number;
};

const stockInclude = {
  product: {
    select: {
      id: true,
      name: true,
      genericName: true,
      brand: true,
      sku: true,
    },
  },
  batch: { select: { id: true, batchNumber: true, expiryDate: true } },
  location: { select: { id: true, name: true } },
} satisfies Prisma.InventoryStockInclude;

export const inventoryStockRepository = {
  findById(id: string) {
    return prisma.inventoryStock.findUnique({ where: { id } });
  },

  async findByBatchAndLocation(batchId: string, locationId: string) {
    return prisma.inventoryStock.findUnique({
      where: { batchId_locationId: { batchId, locationId } },
    });
  },

  async list(query: StockListQuery) {
    const where: Prisma.InventoryStockWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.search
        ? {
            OR: [
              { product: { name: { contains: query.search, mode: "insensitive" as const } } },
              { product: { sku: { contains: query.search, mode: "insensitive" as const } } },
              { batch: { batchNumber: { contains: query.search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.inventoryStock.findMany({
        where,
        include: stockInclude,
        orderBy: { updatedAt: "desc" },
        skip: query.skip,
        take: query.take,
      }),
      prisma.inventoryStock.count({ where }),
    ]);
    return { items, total };
  },

  /** Total base-unit quantity of a product grouped by location. */
  async quantityByLocation(productId: string) {
    const rows = await prisma.inventoryStock.groupBy({
      by: ["locationId"],
      where: { productId, quantity: { gt: 0 } },
      _sum: { quantity: true },
    });
    if (rows.length === 0) {
      return [];
    }
    const locations = await prisma.inventoryLocation.findMany({
      where: { id: { in: rows.map((row) => row.locationId) } },
      select: { id: true, name: true },
    });
    const locationNames = new Map(locations.map((location) => [location.id, location.name]));
    return rows
      .map((row) => ({
        locationId: row.locationId,
        locationName: locationNames.get(row.locationId) ?? null,
        quantity: row._sum.quantity ?? new Prisma.Decimal(0),
      }))
      .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? ""));
  },

  /** Total base-unit quantity of a product across every location. */
  async totalQuantity(productId: string) {
    const aggregate = await prisma.inventoryStock.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    return aggregate._sum.quantity ?? new Prisma.Decimal(0);
  },

  /** Total base-unit quantity of a single batch across locations. */
  async batchTotalQuantity(batchId: string) {
    const aggregate = await prisma.inventoryStock.aggregate({
      where: { batchId },
      _sum: { quantity: true },
    });
    return aggregate._sum.quantity ?? new Prisma.Decimal(0);
  },

  /** Quantity of multiple batches grouped by batch, optionally filtered by location. */
  async quantityByBatchAndLocation(batchIds: string[], locationId?: string) {
    const where: Prisma.InventoryStockWhereInput = {
      batchId: { in: batchIds },
      quantity: { gt: 0 },
      ...(locationId ? { locationId } : {}),
    };

    const rows = await prisma.inventoryStock.groupBy({
      by: ["batchId"],
      where,
      _sum: { quantity: true },
    });

    return rows.map((row) => ({
      batchId: row.batchId,
      quantity: row._sum.quantity ?? new Prisma.Decimal(0),
    }));
  },
};
