import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { productGroupRepository } from "../../repositories/inventory/product-group.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { toDecimal } from "../../utils/decimal.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateProductGroupInput = {
  name: string;
  description?: string;
  defaultProfitMargin?: number;
  isActive?: boolean;
};

export type UpdateProductGroupInput = Partial<CreateProductGroupInput>;

export type ListProductGroupsQuery = PageQuery & {
  search?: string;
  isActive?: boolean;
};

export const productGroupService = {
  async list(query: ListProductGroupsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await productGroupRepository.list({
      search: query.search,
      isActive: query.isActive,
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const group = await productGroupRepository.findById(id);
    if (!group) {
      throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
    }
    return group;
  },

  async create(input: CreateProductGroupInput) {
    const duplicate = await productGroupRepository.findByName(input.name);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_PRODUCT_GROUP, "A product group with this name already exists");
    }
    return productGroupRepository.create({
      name: input.name,
      description: input.description,
      defaultProfitMargin:
        input.defaultProfitMargin !== undefined
          ? toDecimal(input.defaultProfitMargin)
          : undefined,
      isActive: input.isActive,
    });
  },

  async update(id: string, input: UpdateProductGroupInput) {
    const group = await productGroupRepository.findById(id);
    if (!group) {
      throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
    }

    if (input.name !== undefined && input.name.toLowerCase() !== group.name.toLowerCase()) {
      const duplicate = await productGroupRepository.findByName(input.name, id);
      if (duplicate) {
        throw new AppError(409, ErrorCode.DUPLICATE_PRODUCT_GROUP, "A product group with this name already exists");
      }
    }

    return productGroupRepository.update(id, {
      name: input.name,
      description: input.description,
      defaultProfitMargin:
        input.defaultProfitMargin !== undefined
          ? toDecimal(input.defaultProfitMargin)
          : undefined,
      isActive: input.isActive,
    });
  },

  async remove(id: string) {
    const group = await productGroupRepository.findById(id);
    if (!group) {
      throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
    }

    const productCount = await productGroupRepository.countProducts(id);
    if (productCount > 0) {
      throw new AppError(
        409,
        ErrorCode.PRODUCT_GROUP_IN_USE,
        "Cannot delete a product group that still has products",
        { productCount },
      );
    }

    await productGroupRepository.deleteById(id);
  },
};
