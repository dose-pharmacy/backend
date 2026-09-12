import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { productGroupRepository } from "../../repositories/inventory/product-group.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { productUnitRepository } from "../../repositories/inventory/product-unit.repository.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import { unitRepository } from "../../repositories/inventory/unit.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { toDecimal } from "../../utils/decimal.js";
import { prisma } from "../../database/prisma.js";
import type { PageQuery } from "../../utils/pagination.js";

export type ProductUnitConfigInput = {
  /** Id of a reusable master Unit (e.g. \"Box\"). */
  unitId: string;
  /** How many base units one of these units equals. Base unit must be 1. */
  conversionFactor: number;
  sellPrice?: number;
  purchasePrice?: number;
  isBaseUnit?: boolean;
};

export type CreateProductInput = {
  name: string;
  genericName?: string;
  brand?: string;
  sku: string;
  productGroupId: string;
  description?: string;
  imageUrl?: string;
  minimumStock?: number;
  reorderPoint?: number;
  isActive?: boolean;
  /**
   * Optional embedded unit configuration created atomically with the product.
   * Exactly one entry must be the base unit (conversionFactor = 1).
   * When omitted, the product is created without units (legacy flow; units
   * can be added later via POST /products/:productId/units).
   */
  units?: ProductUnitConfigInput[];
};

export type UpdateProductInput = Partial<CreateProductInput> & {
  imageUrl?: string | null;
  reorderPoint?: number | null;
};

export type ListProductsQuery = PageQuery & {
  search?: string;
  productGroupId?: string;
  brand?: string;
  isActive?: boolean;
};

function toOptionalDecimal(value: number | null | undefined): Prisma.Decimal | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : toDecimal(value);
}

type ValidatedUnitConfig = {
  unitId: string;
  conversionFactor: Prisma.Decimal;
  sellPrice: Prisma.Decimal | null;
  purchasePrice: Prisma.Decimal | null;
  isBaseUnit: boolean;
};

/**
 * Validates an incoming unit configuration array:
 *  - every master unit exists and is active
 *  - no duplicate unit supplied
 *  - exactly one base unit
 *  - base unit conversion factor is exactly 1
 *  - non-base conversion factors are greater than zero
 * Returns the normalized configuration ready for persistence.
 */
async function validateUnitConfigs(
  units: ProductUnitConfigInput[],
): Promise<ValidatedUnitConfig[]> {
  if (units.length === 0) {
    throw new AppError(422, ErrorCode.BAD_REQUEST, "At least one unit configuration is required");
  }

  const seen = new Set<string>();
  const validated: ValidatedUnitConfig[] = [];
  let baseCount = 0;

  for (const unitConfig of units) {
    if (seen.has(unitConfig.unitId)) {
      throw new AppError(
        409,
        ErrorCode.DUPLICATE_UNIT,
        "The same unit cannot be configured twice for a product",
      );
    }
    seen.add(unitConfig.unitId);

    const unit = await unitRepository.findById(unitConfig.unitId);
    if (!unit) {
      throw new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Unit not found");
    }
    if (!unit.isActive) {
      throw new AppError(409, ErrorCode.UNIT_INACTIVE, "Unit is not active");
    }

    const isBaseUnit = unitConfig.isBaseUnit === true;
    if (isBaseUnit) {
      baseCount += 1;
      if (unitConfig.conversionFactor !== 1) {
        throw new AppError(
          409,
          ErrorCode.BASE_UNIT_FORBIDDEN,
          "The base unit of a product always has a conversion factor of 1",
        );
      }
    } else if (unitConfig.conversionFactor <= 0) {
      throw new AppError(
        422,
        ErrorCode.INVALID_CONVERSION_FACTOR,
        "Conversion factor must be greater than zero",
      );
    }

    validated.push({
      unitId: unitConfig.unitId,
      conversionFactor: toDecimal(unitConfig.conversionFactor),
      sellPrice: unitConfig.sellPrice !== undefined ? toDecimal(unitConfig.sellPrice) : null,
      purchasePrice:
        unitConfig.purchasePrice !== undefined ? toDecimal(unitConfig.purchasePrice) : null,
      isBaseUnit,
    });
  }

  if (baseCount === 0) {
    throw new AppError(409, ErrorCode.BASE_UNIT_REQUIRED, "Exactly one base unit is required");
  }
  if (baseCount > 1) {
    throw new AppError(409, ErrorCode.BASE_UNIT_EXISTS, "Only one base unit is allowed per product");
  }

  return validated;
}

export const productService = {
  async list(query: ListProductsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await productRepository.list({
      search: query.search,
      productGroupId: query.productGroupId,
      brand: query.brand,
      isActive: query.isActive,
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }
    return product;
  },

  /**
   * Product detail for the frontend detail page: product + product group +
   * units + a bounded stock summary. Batches and transaction history are
   * served by their own paginated endpoints.
   */
  async detail(id: string) {
    const product = await productRepository.findByIdDetailed(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    const [units, totalQuantity, byLocation, usages] = await Promise.all([
      productUnitRepository.findByProductId(id),
      inventoryStockRepository.totalQuantity(id),
      inventoryStockRepository.quantityByLocation(id),
      productRepository.countUsages(id),
    ]);

    const baseUnit = units.find((u) => u.isBaseUnit)?.unit ?? null;

    return {
      ...product,
      baseUnit,
      units,
      stockSummary: {
        totalQuantity,
        baseUnit,
        byLocation,
      },
      batchCount: usages.batches,
      transactionCount: usages.transactions,
      locationCount: byLocation.length,
    };
  },

  /**
   * Creates a product and, when `units` is supplied, its ProductUnit
   * configurations in a single Prisma transaction.
   */
  async create(input: CreateProductInput) {
    const group = await productGroupRepository.findById(input.productGroupId);
    if (!group) {
      throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
    }

    const duplicate = await productRepository.findBySku(input.sku);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
    }

    const validatedUnits =
      input.units !== undefined ? await validateUnitConfigs(input.units) : undefined;

    try {
      const product = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            name: input.name,
            genericName: input.genericName,
            brand: input.brand,
            sku: input.sku,
            productGroupId: input.productGroupId,
            description: input.description,
            imageUrl: input.imageUrl,
            minimumStock: toOptionalDecimal(input.minimumStock) ?? toDecimal(0),
            reorderPoint: toOptionalDecimal(input.reorderPoint),
            isActive: input.isActive,
          },
        });

        if (validatedUnits) {
          await tx.productUnit.createMany({
            data: validatedUnits.map((unitConfig) => ({
              productId: created.id,
              unitId: unitConfig.unitId,
              conversionFactor: unitConfig.conversionFactor,
              sellPrice: unitConfig.sellPrice,
              purchasePrice: unitConfig.purchasePrice,
              isBaseUnit: unitConfig.isBaseUnit,
            })),
          });
        }

        return created;
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      });

      // Return the product with its units when they were created together,
      // so clients get the full picture without a second round trip.
      if (validatedUnits) {
        return productRepository.findByIdWithUnits(product.id);
      }
      return product;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
      throw error;
    }
  },

  /**
   * Updates product fields and, when `units` is supplied, safely upserts the
   * unit configuration: existing configs are updated (conversion factor /
   * prices), missing ones are created. The base unit cannot be removed or
   * re-designated here — use the dedicated unit endpoints for that.
   */
  async update(id: string, input: UpdateProductInput) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    if (input.productGroupId !== undefined && input.productGroupId !== product.productGroupId) {
      const group = await productGroupRepository.findById(input.productGroupId);
      if (!group) {
        throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
      }
    }

    if (input.sku !== undefined && input.sku.toLowerCase() !== product.sku.toLowerCase()) {
      const duplicate = await productRepository.findBySku(input.sku, id);
      if (duplicate) {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
    }

    const validatedUnits =
      input.units !== undefined ? await validateUnitConfigs(input.units) : undefined;

    try {
      return await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id },
          data: {
            name: input.name,
            genericName: input.genericName,
            brand: input.brand,
            sku: input.sku,
            productGroupId: input.productGroupId,
            description: input.description,
            imageUrl: input.imageUrl,
            minimumStock:
              input.minimumStock !== undefined ? toDecimal(input.minimumStock) : undefined,
            reorderPoint: toOptionalDecimal(input.reorderPoint),
            isActive: input.isActive,
          },
        });

        if (validatedUnits) {
          const existingConfigs = await tx.productUnit.findMany({
            where: { productId: id },
            select: { id: true, unitId: true, isBaseUnit: true },
          });
          const byUnitId = new Map(existingConfigs.map((c) => [c.unitId, c]));
          const hasExistingBase = existingConfigs.some((c) => c.isBaseUnit);

          for (const unitConfig of validatedUnits) {
            const existing = byUnitId.get(unitConfig.unitId);
            if (existing) {
              // The base unit designation cannot be changed through a
              // product update (use the dedicated unit endpoints).
              if (!existing.isBaseUnit && unitConfig.isBaseUnit) {
                throw new AppError(
                  409,
                  ErrorCode.BASE_UNIT_FORBIDDEN,
                  "The base unit designation cannot be changed through a product update",
                );
              }
              // The base unit conversion factor is fixed at 1.
              if (existing.isBaseUnit && !unitConfig.conversionFactor.equals(1)) {
                throw new AppError(
                  409,
                  ErrorCode.BASE_UNIT_FORBIDDEN,
                  "The base unit of a product always has a conversion factor of 1",
                );
              }
              await tx.productUnit.update({
                where: { id: existing.id },
                data: {
                  conversionFactor: unitConfig.conversionFactor,
                  sellPrice: unitConfig.sellPrice,
                  purchasePrice: unitConfig.purchasePrice,
                },
              });
            } else if (unitConfig.isBaseUnit && hasExistingBase) {
              // Adding a second base unit is not allowed.
              throw new AppError(
                409,
                ErrorCode.BASE_UNIT_EXISTS,
                "This product already has a base unit",
              );
            } else {
              await tx.productUnit.create({
                data: {
                  productId: id,
                  unitId: unitConfig.unitId,
                  conversionFactor: unitConfig.conversionFactor,
                  sellPrice: unitConfig.sellPrice,
                  purchasePrice: unitConfig.purchasePrice,
                  isBaseUnit: unitConfig.isBaseUnit,
                },
              });
            }
          }
        }

        return productRepository.findByIdWithUnits(id);
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
      throw error;
    }
  },

  async remove(id: string) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    const usages = await productRepository.countUsages(id);
    if (
      usages.units > 0 ||
      usages.batches > 0 ||
      usages.stock > 0 ||
      usages.transactions > 0
    ) {
      throw new AppError(
        409,
        ErrorCode.PRODUCT_IN_USE,
        "Cannot delete a product that has units, batches, stock, or transaction history",
        usages,
      );
    }

    await productRepository.deleteById(id);
  },
};