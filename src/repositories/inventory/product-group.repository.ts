import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

export type ProductGroupListQuery = {
  search?: string;
  isActive?: boolean;
  skip: number;
  take: number;
};

export const productGroupRepository = {
  findById(id: string) {
    // include products in the result for convenience, but don't paginate them here
    return prisma.productGroup.findUnique({
      where: { id },
      include: {
        products: true,
        _count: { select: { products: true } }
      },
    });
  },


  /** Case-insensitive name lookup used for duplicate detection. */
  findByName(name: string, excludeId?: string) {
    return prisma.productGroup.findFirst({
      where: {
        name: { equals: name, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async list(query: ProductGroupListQuery) {
    const where: Prisma.ProductGroupWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search ? { name: { contains: query.search, mode: "insensitive" as const } } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.productGroup.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { products: true } }
        },
        skip: query.skip,
        take: query.take,
      }),
      prisma.productGroup.count({ where }),
    ]);
    return { items, total };
  },

  create(data: { name: string; description?: string; defaultProfitMargin?: Prisma.Decimal; isActive?: boolean }) {
    return prisma.productGroup.create({ data });
  },

  update(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      defaultProfitMargin?: Prisma.Decimal;
      isActive?: boolean;
    },
  ) {
    return prisma.productGroup.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.defaultProfitMargin !== undefined
          ? { defaultProfitMargin: data.defaultProfitMargin }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  },

  deleteById(id: string) {
    return prisma.productGroup.delete({ where: { id } });
  },

  countProducts(id: string) {
    return prisma.product.count({ where: { productGroupId: id } });
  },

  // list a product group's products with pagination
  listProducts(
    id: string,
    query: { skip: number; take: number },
  ) {
    return prisma.product.findMany({
      where: { productGroupId: id },
      orderBy: { createdAt: "desc" },
      skip: query.skip,
      take: query.take,
    });
  }
};
