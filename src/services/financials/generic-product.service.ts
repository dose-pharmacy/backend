import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateGenericProductInput = {
  name: string;
  description?: string | null;
};

export type UpdateGenericProductInput = Partial<CreateGenericProductInput>;

export type GenericProductListQuery = PageQuery & {
  search?: string;
  isActive?: boolean;
};

export type GenericProductWithProducts = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count: {
    products: number;
  };
};

async function assertGenericProductExists(id: string) {
  const gp = await prisma.genericProduct.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!gp) {
    throw new AppError(404, ErrorCode.GENERIC_PRODUCT_NOT_FOUND, "Generic product not found");
  }
}

export const genericProductService = {
  async list(query: GenericProductListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.GenericProductWhereInput = {
      ...(query.search
        ? {
            name: { contains: query.search, mode: "insensitive" as const },
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.genericProduct.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { products: true },
          },
        },
        orderBy: { name: "asc" },
        skip,
        take,
      }),
      prisma.genericProduct.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateGenericProductInput) {
    const existing = await prisma.genericProduct.findFirst({
      where: { name: { equals: input.name, mode: "insensitive" as const } },
    });
    if (existing) {
      throw new AppError(409, ErrorCode.DUPLICATE_GENERIC_PRODUCT, "A generic product with this name already exists");
    }

    return prisma.genericProduct.create({
      data: {
        name: input.name,
        description: input.description,
      },
    });
  },

  async getById(id: string): Promise<GenericProductWithProducts> {
    const gp = await prisma.genericProduct.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { products: true },
        },
      },
    });

    if (!gp) {
      throw new AppError(404, ErrorCode.GENERIC_PRODUCT_NOT_FOUND, "Generic product not found");
    }

    return gp;
  },

  async update(id: string, input: UpdateGenericProductInput) {
    await assertGenericProductExists(id);

    if (input.name !== undefined) {
      const existing = await prisma.genericProduct.findFirst({
        where: {
          name: { equals: input.name, mode: "insensitive" as const },
          id: { not: id },
        },
      });
      if (existing) {
        throw new AppError(409, ErrorCode.DUPLICATE_GENERIC_PRODUCT, "A generic product with this name already exists");
      }
    }

    return prisma.genericProduct.update({
      where: { id },
      data: input,
    });
  },

  async remove(id: string) {
    await assertGenericProductExists(id);

    const usage = await prisma.product.count({
      where: { genericProductId: id },
    });
    if (usage > 0) {
      throw new AppError(409, ErrorCode.GENERIC_PRODUCT_IN_USE, "Cannot delete generic product with associated products", { productCount: usage });
    }

    await prisma.genericProduct.delete({ where: { id } });
  },
};