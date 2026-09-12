import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

const unitSelect = {
  unit: {
    select: { id: true, name: true, symbol: true, isActive: true },
  },
} satisfies Prisma.ProductUnitInclude;

export const productUnitRepository = {
  findById(id: string, client: DbClient = prisma) {
    return client.productUnit.findUnique({
      where: { id },
      include: unitSelect,
    });
  },

  findByProductId(productId: string, client: DbClient = prisma) {
    return client.productUnit.findMany({
      where: { productId },
      include: unitSelect,
      orderBy: [{ isBaseUnit: "desc" }, { createdAt: "asc" }],
    });
  },

  findBaseUnit(productId: string, client: DbClient = prisma) {
    return client.productUnit.findFirst({
      where: { productId, isBaseUnit: true },
      include: unitSelect,
    });
  },

  /** Finds the ProductUnit for a (product, master unit) pair. */
  findByProductAndUnit(productId: string, unitId: string, client: DbClient = prisma) {
    return client.productUnit.findFirst({
      where: { productId, unitId },
      include: unitSelect,
    });
  },

  create(data: {
    productId: string;
    unitId: string;
    conversionFactor: Prisma.Decimal;
    sellPrice?: Prisma.Decimal | null;
    purchasePrice?: Prisma.Decimal | null;
    isBaseUnit?: boolean;
  }) {
    return prisma.productUnit.create({ data, include: unitSelect });
  },

  update(
    id: string,
    data: Partial<{
      conversionFactor: Prisma.Decimal;
      sellPrice: Prisma.Decimal | null;
      purchasePrice: Prisma.Decimal | null;
    }>,
  ) {
    return prisma.productUnit.update({ where: { id }, data, include: unitSelect });
  },

  deleteById(id: string) {
    return prisma.productUnit.delete({ where: { id } });
  },
};