import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import {
  assertValidSlowMovingDefinition,
  evaluateSlowMoving,
  type SlowMovingEvaluationResult,
} from "./reports/slow-moving-evaluation.js";

export type SlowMovingDefinitionType =
  | "DAYS_30"
  | "DAYS_60"
  | "DAYS_90"
  | "DAYS_180"
  | "CUSTOM";

export type CreateSlowMovingConfigInput = {
  productId: string;
  definitionType: SlowMovingDefinitionType;
  customDays?: number | null;
};

export type UpdateSlowMovingConfigInput = Partial<{
  definitionType: SlowMovingDefinitionType;
  customDays: number | null;
}>;

export type SlowMovingConfigListQuery = PageQuery & {
  productId?: string;
  isFlagged?: boolean;
  definitionType?: SlowMovingDefinitionType;
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
    throw new AppError(
      404,
      ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND,
      "Slow moving configuration not found",
    );
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
            select: {
              id: true,
              name: true,
              sku: true,
              productGroup: { select: { id: true, name: true } },
            },
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
      throw new AppError(
        409,
        ErrorCode.BAD_REQUEST,
        "Slow moving configuration already exists for this product",
      );
    }

    assertValidSlowMovingDefinition(input.definitionType, input.customDays);

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
          select: {
            id: true,
            name: true,
            sku: true,
            productGroup: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!config) {
      throw new AppError(
        404,
        ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND,
        "Slow moving configuration not found",
      );
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
      throw new AppError(
        404,
        ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND,
        "Slow moving configuration not found for this product",
      );
    }
    return config;
  },

  async update(id: string, input: UpdateSlowMovingConfigInput) {
    const existing = await prisma.slowMovingConfiguration.findUnique({
      where: { id },
      select: { id: true, definitionType: true, customDays: true },
    });
    if (!existing) {
      throw new AppError(
        404,
        ErrorCode.SLOW_MOVING_CONFIG_NOT_FOUND,
        "Slow moving configuration not found",
      );
    }

    // Validate the effective definition (payload merged over stored values) so
    // switching to CUSTOM cannot leave an invalid threshold in the database.
    const effectiveType = input.definitionType ?? existing.definitionType;
    const effectiveCustomDays =
      input.customDays !== undefined ? input.customDays : existing.customDays;
    assertValidSlowMovingDefinition(effectiveType, effectiveCustomDays);

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

  /**
   * Runs the robust evaluation engine (single grouped query, advisory-lock
   * concurrency guard, one atomic bulk update).
   */
  async evaluateSlowMoving(): Promise<SlowMovingEvaluationResult> {
    return evaluateSlowMoving();
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
