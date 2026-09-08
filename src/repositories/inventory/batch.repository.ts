import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { addUtcDays, toUtcDayStart } from "../../utils/date-time.js";

export type BatchListQuery = {
  productId?: string;
  search?: string;
  expiresBefore?: Date;
  expiresAfter?: Date;
  skip: number;
  take: number;
};

export type QuantityByBatchAndLocationQuery = {
  batchIds: string[];
  locationId?: string;
};

const batchDetailInclude = {
  product: {
    select: {
      id: true,
      name: true,
      genericName: true,
      brand: true,
      sku: true,
    },
  },
} satisfies Prisma.BatchInclude;

export const batchRepository = {
  findById(id: string) {
    return prisma.batch.findUnique({
      where: { id },
      include: batchDetailInclude,
    });
  },

  /** Finds a batch for a product by its number (case-insensitive). */
  findByNumber(productId: string, batchNumber: string, excludeId?: string) {
    return prisma.batch.findFirst({
      where: {
        productId,
        batchNumber: { equals: batchNumber, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async list(query: BatchListQuery) {
    const where: Prisma.BatchWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.search
        ? { batchNumber: { contains: query.search, mode: "insensitive" as const } }
        : {}),
      ...(query.expiresAfter
        ? { expiryDate: { gte: toUtcDayStart(query.expiresAfter) } }
        : {}),
      ...(query.expiresBefore
        ? {
            expiryDate: { lt: addUtcDays(toUtcDayStart(query.expiresBefore), 1) },
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.batch.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, sku: true, brand: true } },
        },
        orderBy: [{ expiryDate: "asc" }, { createdAt: "desc" }],
        skip: query.skip,
        take: query.take,
      }),
      prisma.batch.count({ where }),
    ]);
    return { items, total };
  },

  create(data: {
    productId: string;
    batchNumber: string;
    manufacturingDate?: Date | null;
    receivedDate?: Date | null;
    expiryDate: Date;
    purchaseCost?: Prisma.Decimal | null;
    supplierReference?: string | null;
  }) {
    return prisma.batch.create({ data });
  },

  update(
    id: string,
    data: Partial<{
      batchNumber: string;
      manufacturingDate: Date | null;
      receivedDate: Date | null;
      expiryDate: Date;
      purchaseCost: Prisma.Decimal | null;
      supplierReference: string | null;
    }>,
  ) {
    return prisma.batch.update({ where: { id }, data });
  },

  deleteById(id: string) {
    return prisma.batch.delete({ where: { id } });
  },

  async countUsages(id: string): Promise<{ stock: number; transactions: number }> {
    const [stock, transactions] = await prisma.$transaction([
      prisma.inventoryStock.count({ where: { batchId: id } }),
      prisma.stockTransaction.count({ where: { batchId: id } }),
    ]);
    return { stock, transactions };
  },

  async quantityByBatchAndLocation(
    batchIds: string[],
    locationId?: string,
  ): Promise<Array<{ batchId: string; quantity: Prisma.Decimal }>> {
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
