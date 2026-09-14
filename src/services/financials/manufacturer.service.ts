import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateManufacturerInput = {
  name: string;
  contactInfo?: string | null;
  isActive?: boolean;
};

export type UpdateManufacturerInput = Partial<CreateManufacturerInput>;

export type ManufacturerListQuery = PageQuery & {
  search?: string;
  isActive?: boolean;
};

export type ManufacturerWithProducts = {
  id: string;
  name: string;
  contactInfo: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: {
    products: number;
  };
};

async function assertManufacturerExists(id: string) {
  const m = await prisma.manufacturer.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!m) {
    throw new AppError(404, ErrorCode.MANUFACTURER_NOT_FOUND, "Manufacturer not found");
  }
}

async function _assertManufacturerActive(id: string) {
  const m = await prisma.manufacturer.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!m) {
    throw new AppError(404, ErrorCode.MANUFACTURER_NOT_FOUND, "Manufacturer not found");
  }
  if (!m.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_MANUFACTURER, "Manufacturer is not active");
  }
}

export const manufacturerService = {
  async list(query: ManufacturerListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.ManufacturerWhereInput = {
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              { contactInfo: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.manufacturer.findMany({
        where,
        select: {
          id: true,
          name: true,
          contactInfo: true,
          isActive: true,
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
      prisma.manufacturer.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateManufacturerInput) {
    const existing = await prisma.manufacturer.findFirst({
      where: { name: { equals: input.name, mode: "insensitive" as const } },
    });
    if (existing) {
      throw new AppError(409, ErrorCode.DUPLICATE_MANUFACTURER, "A manufacturer with this name already exists");
    }

    return prisma.manufacturer.create({
      data: {
        name: input.name,
        contactInfo: input.contactInfo,
        isActive: input.isActive ?? true,
      },
    });
  },

  async getById(id: string): Promise<ManufacturerWithProducts> {
    const manufacturer = await prisma.manufacturer.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        contactInfo: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { products: true },
        },
      },
    });

    if (!manufacturer) {
      throw new AppError(404, ErrorCode.MANUFACTURER_NOT_FOUND, "Manufacturer not found");
    }

    return manufacturer;
  },

  async update(id: string, input: UpdateManufacturerInput) {
    await assertManufacturerExists(id);

    if (input.name !== undefined) {
      const existing = await prisma.manufacturer.findFirst({
        where: {
          name: { equals: input.name, mode: "insensitive" as const },
          id: { not: id },
        },
      });
      if (existing) {
        throw new AppError(409, ErrorCode.DUPLICATE_MANUFACTURER, "A manufacturer with this name already exists");
      }
    }

    return prisma.manufacturer.update({
      where: { id },
      data: input,
    });
  },

  async remove(id: string) {
    await assertManufacturerExists(id);

    const usage = await prisma.product.count({
      where: { manufacturerId: id },
    });
    if (usage > 0) {
      throw new AppError(409, ErrorCode.MANUFACTURER_IN_USE, "Cannot delete manufacturer with associated products", { productCount: usage });
    }

    await prisma.manufacturer.delete({ where: { id } });
  },
};