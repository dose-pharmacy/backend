import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { productUnitRepository } from "../../repositories/inventory/product-unit.repository.js";
import { roundTo, toDecimal } from "../../utils/decimal.js";

export type CreateUnitInput = {
  name: string;
  conversionFactor: number;
  sellPrice?: number;
  purchasePrice?: number;
  isBaseUnit?: boolean;
};

export type UpdateUnitInput = Partial<{
  name: string;
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

export const productUnitService = {
  async listUnits(productId: string) {
    await assertProductExists(productId);
    return productUnitRepository.findByProductId(productId);
  },

  async createUnit(productId: string, input: CreateUnitInput) {
    await assertProductExists(productId);

    const existingName = await productUnitRepository.findByName(productId, input.name);
    if (existingName) {
      throw new AppError(409, ErrorCode.DUPLICATE_UNIT, "A unit with this name already exists");
    }

    const wantsBaseUnit = input.isBaseUnit === true;
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
        name: input.name,
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
        throw new AppError(409, ErrorCode.DUPLICATE_UNIT, "A unit with this name already exists");
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

    if (input.name !== undefined && input.name !== unit.name) {
      const existing = await productUnitRepository.findByName(productId, input.name, unitId);
      if (existing) {
        throw new AppError(409, ErrorCode.DUPLICATE_UNIT, "A unit with this name already exists");
      }
    }

    if (input.conversionFactor !== undefined) {
      if (unit.isBaseUnit && input.conversionFactor !== 1) {
        throw new AppError(
          409,
          ErrorCode.BASE_UNIT_FORBIDDEN,
          "The base unit of a product always has a conversion factor of 1",
        );
      }
    }

    return productUnitRepository.update(unitId, {
      name: input.name,
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
        "The base unit cannot be deleted",
      );
    }
    await productUnitRepository.deleteById(unitId);
  },

  /**
   * Converts a quantity expressed in a product unit into base units.
   * baseQuantity = quantity x conversionFactor (rounded to the stock scale).
   */
  async toBaseQuantity(productId: string, unitId: string, quantity: number) {
    const unit = await productUnitRepository.findById(unitId);
    if (!unit) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "Unit not found");
    }
    if (unit.productId !== productId) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "The unit does not belong to the given product");
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
  ) {
    const [fromUnit, toUnit] = await Promise.all([
      productUnitRepository.findById(input.fromUnitId),
      productUnitRepository.findById(input.toUnitId),
    ]);
    if (!fromUnit) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "Source unit not found");
    }
    if (!toUnit) {
      throw new AppError(422, ErrorCode.INVALID_UNIT, "Target unit not found");
    }
    if (fromUnit.productId !== productId || toUnit.productId !== productId) {
      throw new AppError(
        422,
        ErrorCode.UNIT_PRODUCT_MISMATCH,
        "Both units must belong to the given product",
      );
    }

    const convertedQuantity = roundTo(
      toDecimal(input.quantity)
        .mul(fromUnit.conversionFactor)
        .div(toUnit.conversionFactor),
      3,
    );

    return {
      originalQuantity: input.quantity,
      fromUnit: fromUnit.name,
      toUnit: toUnit.name,
      convertedQuantity: convertedQuantity.toNumber(),
    };
  },
};
