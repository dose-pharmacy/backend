import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

export type LocationListQuery = {
  search?: string;
  isActive?: boolean;
  skip: number;
  take: number;
};

export const inventoryLocationRepository = {
  findById(id: string) {
    return prisma.inventoryLocation.findUnique({ where: { id } });
  },

  findByName(name: string, excludeId?: string) {
    return prisma.inventoryLocation.findFirst({
      where: {
        name: { equals: name, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async list(query: LocationListQuery) {
    const where: Prisma.InventoryLocationWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: "insensitive" as const } }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.inventoryLocation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: query.skip,
        take: query.take,
      }),
      prisma.inventoryLocation.count({ where }),
    ]);
    return { items, total };
  },

  create(data: { name: string; description?: string; isActive?: boolean }) {
    return prisma.inventoryLocation.create({ data });
  },

  update(
    id: string,
    data: { name?: string; description?: string | null; isActive?: boolean },
  ) {
    return prisma.inventoryLocation.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  },

  deleteById(id: string) {
    return prisma.inventoryLocation.delete({ where: { id } });
  },

  async countUsages(id: string): Promise<{ stock: number; transactions: number }> {
    const [stock, transactions] = await prisma.$transaction([
      prisma.inventoryStock.count({ where: { locationId: id } }),
      prisma.stockTransaction.count({ where: { locationId: id } }),
    ]);
    return { stock, transactions };
  },
};
