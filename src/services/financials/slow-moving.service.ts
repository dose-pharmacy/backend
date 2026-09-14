import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { startOfTodayUtc, addUtcDays } from "../../utils/date-time.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateSlowMovingConfigInput = {
  productId: string;
  definitionType: "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM";
  customDays?: number | null;
};

export type UpdateSlowMovingConfigInput = Partial<{
  definitionType: "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM";
  customDays: number | null;
}>;

export type SlowMovingConfigListQuery = PageQuery & {
  productId?: string;
  isFlagged?: boolean;
  definitionType?: "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM";
};

async function assertProductExists(productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, isActive: true },
  });
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
  if (!product.isActive) {
    throw new AppError(409, ErrorCode.PRODUCT_NOT_FOUND, "Product is not active");
  }
}

async function assertConfigExists(id: string) {
  const config = await prisma.slowMovingConfiguration.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!config) {
    throw new AppError(404, ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND, "Slow moving configuration not found");
  }
}

function getThresholdDays(definitionType: string, customDays?: number | null): number {
  switch (definitionType) {
    case "DAYS_30":
      return 30;
    case "DAYS_60":
      return 60;
    case "DAYS_90":
      return 90;
    case "DAYS_180":
      return 180;
    case "CUSTOM":
      return customDays ?? 90;
    default:
      return 90;
  }
}

export const slowMovingConfigService = {
  async list(query: SlowMovingConfigListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.SlowMovingConfigurationWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.isFlagged !== undefined ? { isFlagged: query.isFlagged } : {}),
      ...(query.definitionType ? { definitionType: query.definitionType } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.slowMovingConfiguration.findMany({
        where,
        include: {
          product: {
            select: { id: true, name: true, sku: true, productGroup: { select: { id: true, name: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.slowMovingConfiguration.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateSlowMovingConfigInput) {
    await assertProductExists(input.productId);

    const existing = await prisma.slowMovingConfiguration.findUnique({
      where: { productId: input.productId },
    });
    if (existing) {
      throw new AppError(409, ErrorCode.BAD_REQUEST, "Slow moving configuration already exists for this product");
    }

    if (input.definitionType === "CUSTOM" && (!input.customDays || input.customDays <= 0)) {
      throw new AppError(422, ErrorCode.INVALID_SLOW_MOVING_DEFINITION, "Custom days must be provided for CUSTOM definition type");
    }

    return prisma.slowMovingConfiguration.create({
      data: {
        productId: input.productId,
        definitionType: input.definitionType,
        customDays: input.customDays,
      },
      include: {
        product: {
          select: { id: true, name: true, sku: true },
        },
      },
    });
  },

  async getById(id: string) {
    const config = await prisma.slowMovingConfiguration.findUnique({
      where: { id },
      include: {
        product: {
          select: { id: true, name: true, sku: true, productGroup: { select: { id: true, name: true } } },
        },
      },
    });
    if (!config) {
      throw new AppError(404, ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND, "Slow moving configuration not found");
    }
    return config;
  },

  async getByProductId(productId: string) {
    const config = await prisma.slowMovingConfiguration.findUnique({
      where: { productId },
      include: {
        product: {
          select: { id: true, name: true, sku: true },
        },
      },
    });
    if (!config) {
      throw new AppError(404, ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND, "Slow moving configuration not found for this product");
    }
    return config;
  },

  async update(id: string, input: UpdateSlowMovingConfigInput) {
    await assertConfigExists(id);

    if (input.definitionType === "CUSTOM" && (input.customDays === null || input.customDays === undefined || input.customDays <= 0)) {
      throw new AppError(422, ErrorCode.INVALID_SLOW_MOVING_DEFINITION, "Custom days must be provided for CUSTOM definition type");
    }

    return prisma.slowMovingConfiguration.update({
      where: { id },
      data: input,
      include: {
        product: {
          select: { id: true, name: true, sku: true },
        },
      },
    });
  },

  async remove(id: string) {
    await assertConfigExists(id);
    await prisma.slowMovingConfiguration.delete({ where: { id } });
  },

  async evaluateSlowMoving() {
    // Get all slow moving configurations
    const configs = await prisma.slowMovingConfiguration.findMany({
      include: {
        product: {
          select: { id: true, name: true, sku: true },
        },
      },
    });

    const results = [];

    for (const config of configs) {
      const thresholdDays = getThresholdDays(config.definitionType, config.customDays);
      const _cutoffDate = addUtcDays(startOfTodayUtc(), -thresholdDays);

      // Find the last sale date for this product
      const lastSale = await prisma.saleLine.findFirst({
        where: {
          productId: config.productId,
          sale: {
            status: "COMPLETED",
          },
        },
        select: { sale: { select: { createdAt: true } } },
        orderBy: { sale: { createdAt: "desc" } },
      });

      const lastSaleDate = lastSale?.sale.createdAt ?? null;
      const daysSinceLastSale = lastSaleDate
        ? Math.floor((startOfTodayUtc().getTime() - lastSaleDate.getTime()) / 86400000)
        : null;

      const isFlagged = lastSaleDate ? daysSinceLastSale! > thresholdDays : false;

      // Update configuration
      await prisma.slowMovingConfiguration.update({
        where: { id: config.id },
        data: {
          lastSaleDate,
          daysSinceLastSale,
          isFlagged,
        },
      });

      results.push({
        productId: config.productId,
        productName: config.product.name,
        sku: config.product.sku,
        definitionType: config.definitionType,
        thresholdDays,
        lastSaleDate,
        daysSinceLastSale,
        isFlagged,
      });
    }

    return results;
  },

  async getFlaggedProducts(query: PageQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const [items, total] = await prisma.$transaction([
      prisma.slowMovingConfiguration.findMany({
        where: { isFlagged: true },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              productGroup: { select: { id: true, name: true } },
              manufacturer: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take,
      }),
      prisma.slowMovingConfiguration.count({ where: { isFlagged: true } }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};