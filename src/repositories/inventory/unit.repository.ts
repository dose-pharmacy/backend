import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

export type UnitListQuery = {
  search?: string;
  isActive?: boolean;
  skip: number;
  take: number;
};

export const unitRepository = {
  findById(id: string) {
    return prisma.unit.findUnique({ where: { id } });
  },

  findByName(name: string, excludeId?: string) {
    return prisma.unit.findFirst({
      where: {
        name: { equals: name, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async list(query: UnitListQuery) {
    const where: Prisma.UnitWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              { symbol: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.unit.findMany({
        where,
        orderBy: { name: "asc" },
        skip: query.skip,
        take: query.take,
        include: {
          _count: { select: { productUnits: true } },
        },
      }),
      prisma.unit.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        productCount: item._count.productUnits,
      })),
      total,
    };
  },

  create(data: { name: string; symbol?: string | null; description?: string | null; isActive?: boolean }) {
    return prisma.unit.create({ data });
  },

  update(
    id: string,
    data: {
      name?: string;
      symbol?: string | null;
      description?: string | null;
      isActive?: boolean;
    },
  ) {
    return prisma.unit.update({ where: { id }, data });
  },

  /** Soft delete: deactivate instead of removing so history stays intact. */
  softDelete(id: string) {
    return prisma.unit.update({ where: { id }, data: { isActive: false } });
  },

  async countUsages(id: string): Promise<{ productUnits: number; transferItems: number }> {
    const [productUnits, transferItems] = await prisma.$transaction([
      prisma.productUnit.count({ where: { unitId: id } }),
      prisma.stockTransferItem.count({ where: { unitId: id } }),
    ]);
    return { productUnits, transferItems };
  },
};