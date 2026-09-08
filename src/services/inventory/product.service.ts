import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { productGroupRepository } from "../../repositories/inventory/product-group.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { productUnitRepository } from "../../repositories/inventory/product-unit.repository.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { toDecimal } from "../../utils/decimal.js";
import type { PageQuery } from "../../utils/pagination.js";

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

    return {
      ...product,
      units,
      stockSummary: {
        totalQuantity,
        byLocation,
      },
      batchCount: usages.batches,
      transactionCount: usages.transactions,
    };
  },

  async create(input: CreateProductInput) {
    const group = await productGroupRepository.findById(input.productGroupId);
    if (!group) {
      throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
    }

    const duplicate = await productRepository.findBySku(input.sku);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
    }

    try {
      return await productRepository.create({
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
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
      throw error;
    }
  },

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

    try {
      return await productRepository.update(id, {
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
