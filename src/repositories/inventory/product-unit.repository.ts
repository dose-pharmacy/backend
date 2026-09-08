import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

export const productUnitRepository = {
  findById(id: string) {
    return prisma.productUnit.findUnique({ where: { id } });
  },

  findByProductId(productId: string) {
    return prisma.productUnit.findMany({
      where: { productId },
      orderBy: [{ isBaseUnit: "desc" }, { createdAt: "asc" }],
    });
  },

  findBaseUnit(productId: string) {
    return prisma.productUnit.findFirst({
      where: { productId, isBaseUnit: true },
    });
  },

  findByName(productId: string, name: string, excludeId?: string) {
    return prisma.productUnit.findFirst({
      where: {
        productId,
        name: { equals: name, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  create(data: {
    productId: string;
    name: string;
    conversionFactor: Prisma.Decimal;
    sellPrice?: Prisma.Decimal | null;
    purchasePrice?: Prisma.Decimal | null;
    isBaseUnit?: boolean;
  }) {
    return prisma.productUnit.create({ data });
  },

  update(
    id: string,
    data: Partial<{
      name: string;
      conversionFactor: Prisma.Decimal;
      sellPrice: Prisma.Decimal | null;
      purchasePrice: Prisma.Decimal | null;
    }>,
  ) {
    return prisma.productUnit.update({ where: { id }, data });
  },

  deleteById(id: string) {
    return prisma.productUnit.delete({ where: { id } });
  },
};
