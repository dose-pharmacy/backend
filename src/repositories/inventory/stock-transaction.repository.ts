import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

const transactionInclude = {
  batch: {
    select: {
      id: true,
      batchNumber: true,
      expiryDate: true,
    },
  },
  location: {
    select: { id: true, name: true },
  },
  createdBy: {
    select: { id: true, name: true, email: true },
  },
} satisfies Prisma.StockTransactionInclude;

export const stockTransactionRepository = {
  async listByProduct(productId: string, query: { skip: number; take: number }) {
    const where: Prisma.StockTransactionWhereInput = { productId };
    const [items, total] = await prisma.$transaction([
      prisma.stockTransaction.findMany({
        where,
        include: transactionInclude,
        orderBy: { createdAt: "desc" },
        skip: query.skip,
        take: query.take,
      }),
      prisma.stockTransaction.count({ where }),
    ]);
    return { items, total };
  },
};
