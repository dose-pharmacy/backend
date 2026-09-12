import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { productUnitRepository } from "../../repositories/inventory/product-unit.repository.js";
import { unitRepository } from "../../repositories/inventory/unit.repository.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";

export type CreateUnitInput = {
  unitId: string;
  conversionFactor: number;
  sellPrice?: number;
  purchasePrice?: number;
  isBaseUnit?: boolean;
};

export type UpdateUnitInput = Partial<{
  conversionFactor: number;
  sellPrice: number | null;
  purchasePrice: number | null;
}>;

function unitNotFoundError(): AppError {
  return new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Product unit not found");
}

function unitMismatchError(): AppError {
  return new AppError(
    422,
    ErrorCode.UNIT_PRODUCT_MISMATCH,
    "The unit does not belong to the given product",
  );
}

async function assertProductExists(productId: string): Promise<void> {
  const product = await productRepository.findById(productId);
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
}

/**
 * Asserts the master unit exists and is active. Inactive units can keep
 * serving historical records but cannot be attached to products/transfers.
 */
export async function assertUnitAvailable(unitId: string): Promise<void> {
  const unit = await unitRepository.findById(unitId);
  if (!unit) {
    throw new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Unit not found");
  }
  if (!unit.isActive) {
    throw new AppError(409, ErrorCode.UNIT_INACTIVE, "Unit is not active");
  }
}

export const productUnitService = {
  async listUnits(productId: string) {
    await assertProductExists(productId);
    return productUnitRepository.findByProductId(productId);
  },

  async createUnit(productId: string, input: CreateUnitInput) {
    await assertProductExists(productId);
    await assertUnitAvailable(input.unitId);

    const existing = await productUnitRepository.findByProductAndUnit(productId, input.unitId);
    if (existing) {
      throw new AppError(
        409,
        ErrorCode.DUPLICATE_UNIT,
        "This unit is already configured for the product",
      );
    }

    if (input.conversionFactor <= 0) {
      throw new AppError(
        422,
        ErrorCode.INVALID_CONVERSION_FACTOR,
        "Conversion factor must be greater than zero",
      );
    }

    const wantsBaseUnit = input.isBaseUnit === true;
    if (wantsBaseUnit && input.conversionFactor !== 1) {
      throw new AppError(
        409,
        ErrorCode.BASE_UNIT_FORBIDDEN,
        "The base unit of a product always has a conversion factor of 1",
      );
    }
    if (wantsBaseUnit) {
      const currentBase = await productUnitRepository.findBaseUnit(productId);
      if (currentBase) {
        throw new AppError(
          409,
          ErrorCode.BASE_UNIT_EXISTS,
          "This product already has a base unit",
        );
      }
    }

    try {
      return await productUnitRepository.create({
        productId,
        unitId: input.unitId,
        conversionFactor: toDecimal(input.conversionFactor),
        sellPrice: input.sellPrice !== undefined ? toDecimal(input.sellPrice) : null,
        purchasePrice: input.purchasePrice !== undefined ? toDecimal(input.purchasePrice) : null,
        isBaseUnit: wantsBaseUnit,
      });
    } catch (error) {
      // Only a create/create race can reach here (the pre-check is the
      // friendly path); map the unique violation to the domain error.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new AppError(
          409,
          ErrorCode.DUPLICATE_UNIT,
          "This unit is already configured for the product",
        );
      }
      throw error;
    }
  },

  async updateUnit(productId: string, unitId: string, input: UpdateUnitInput) {
    const unit = await productUnitRepository.findById(unitId);
    if (!unit) {
      throw unitNotFoundError();
    }
    if (unit.productId !== productId) {
      throw unitMismatchError();
    }

    if (input.conversionFactor !== undefined) {
      if (unit.isBaseUnit && input.conversionFactor !== 1) {
        throw new AppError(
          409,
          ErrorCode.BASE_UNIT_FORBIDDEN,
          "The base unit of a product always has a conversion factor of 1",
        );
      }
      if (!unit.isBaseUnit && input.conversionFactor <= 0) {
        throw new AppError(
          422,
          ErrorCode.INVALID_CONVERSION_FACTOR,
          "Conversion factor must be greater than zero",
        );
      }
    }

    return productUnitRepository.update(unitId, {
      conversionFactor:
        input.conversionFactor !== undefined ? toDecimal(input.conversionFactor) : undefined,
      sellPrice:
        input.sellPrice !== undefined
          ? input.sellPrice === null
            ? null
            : toDecimal(input.sellPrice)
          : undefined,
      purchasePrice:
        input.purchasePrice !== undefined
          ? input.purchasePrice === null
            ? null
            : toDecimal(input.purchasePrice)
          : undefined,
    });
  },

  async deleteUnit(productId: string, unitId: string) {
    const unit = await productUnitRepository.findById(unitId);
    if (!unit) {
      throw unitNotFoundError();
    }
    if (unit.productId !== productId) {
      throw unitMismatchError();
    }
    if (unit.isBaseUnit) {
      throw new AppError(
        409,
        ErrorCode.BASE_UNIT_FORBIDDEN,
        "The base unit cannot be deleted; a product must always have exactly one base unit",
      );
    }
    await productUnitRepository.deleteById(unitId);
  },

  /**
   * Converts a quantity expressed in a product unit into base units.
   * baseQuantity = quantity x conversionFactor (rounded to the stock scale).
   *
   * This is the ONLY place user-facing units are converted to base units.
   * The stock movement engine is unit-agnostic and receives base units.
   *
   * `client` lets callers run the lookup inside their own transaction
   * (e.g. transfer item creation/completion).
   */
  async toBaseQuantity(
    productId: string,
    unitId: string,
    quantity: number,
    client: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    const unit = await productUnitRepository.findByProductAndUnit(productId, unitId, client);
    if (!unit) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "The unit is not configured for the given product");
    }
    if (!unit.unit.isActive) {
      throw new AppError(409, ErrorCode.UNIT_INACTIVE, "Unit is not active");
    }

    const baseQuantity = roundTo(
      toDecimal(quantity).mul(unit.conversionFactor),
      3,
    );
    if (baseQuantity.lte(0)) {
      throw new AppError(422, ErrorCode.INVALID_STOCK_QUANTITY, "Quantity is too small after conversion");
    }

    return { baseQuantity, unit };
  },

  async convert(
    productId: string,
    input: { quantity: number; fromUnitId: string; toUnitId: string },
    client: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    const [fromUnit, toUnit] = await Promise.all([
      productUnitRepository.findByProductAndUnit(productId, input.fromUnitId, client),
      productUnitRepository.findByProductAndUnit(productId, input.toUnitId, client),
    ]);
    if (!fromUnit) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "Source unit is not configured for the given product");
    }
    if (!toUnit) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "Target unit is not configured for the given product");
    }

    const convertedQuantity = roundTo(
      toDecimal(input.quantity)
        .mul(fromUnit.conversionFactor)
        .div(toUnit.conversionFactor),
      3,
    );

    return {
      originalQuantity: input.quantity,
      fromUnit: fromUnit.unit.name,
      toUnit: toUnit.unit.name,
      convertedQuantity: convertedQuantity.toNumber(),
    };
  },
};