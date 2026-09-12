import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

export type ProductListQuery = {
  search?: string;
  productGroupId?: string;
  brand?: string;
  isActive?: boolean;
  skip: number;
  take: number;
};

const productSummarySelect = {
  id: true,
  name: true,
  genericName: true,
  brand: true,
  sku: true,
  isActive: true,
} satisfies Prisma.ProductSelect;

export const productRepository = {
  findById(id: string) {
    return prisma.product.findUnique({ where: { id } });
  },

  findByIdDetailed(id: string) {
    return prisma.product.findUnique({
      where: { id },
      include: {
        productGroup: {
          select: { id: true, name: true, isActive: true },
        },
      },
    });
  },

  findByIdWithUnits(id: string) {
    return prisma.product.findUnique({
      where: { id },
      include: {
        units: {
          include: {
            unit: { select: { id: true, name: true, symbol: true, isActive: true } },
          },
          orderBy: [{ isBaseUnit: "desc" }, { createdAt: "asc" }],
        },
      },
    });
  },

  findBySku(sku: string, excludeId?: string) {
    return prisma.product.findFirst({
      where: {
        sku: { equals: sku, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async list(query: ProductListQuery) {
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

    const [items, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: {
          ...productSummarySelect,
          productGroup: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: query.skip,
        take: query.take,
      }),
      prisma.product.count({ where }),
    ]);
    return { items, total };
  },

  create(data: {
    name: string;
    genericName?: string | null;
    brand?: string | null;
    sku: string;
    description?: string | null;
    imageUrl?: string | null;
    minimumStock?: Prisma.Decimal;
    reorderPoint?: Prisma.Decimal | null;
    isActive?: boolean;
    productGroupId: string;
  }) {
    return prisma.product.create({ data });
  },

  update(
    id: string,
    data: Partial<{
      name: string;
      genericName: string | null;
      brand: string | null;
      sku: string;
      description: string | null;
      imageUrl: string | null;
      minimumStock: Prisma.Decimal;
      reorderPoint: Prisma.Decimal | null;
      isActive: boolean;
      productGroupId: string;
    }>,
  ) {
    return prisma.product.update({ where: { id }, data });
  },

  deleteById(id: string) {
    return prisma.product.delete({ where: { id } });
  },

  async countUsages(id: string): Promise<{
    units: number;
    batches: number;
    stock: number;
    transactions: number;
  }> {
    const [units, batches, stock, transactions] = await prisma.$transaction([
      prisma.productUnit.count({ where: { productId: id } }),
      prisma.batch.count({ where: { productId: id } }),
      prisma.inventoryStock.count({ where: { productId: id } }),
      prisma.stockTransaction.count({ where: { productId: id } }),
    ]);
    return { units, batches, stock, transactions };
  },
};
