import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { unitRepository } from "../../repositories/inventory/unit.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateUnitInput = {
  name: string;
  symbol?: string;
  description?: string;
  isActive?: boolean;
};

export type UpdateUnitInput = Partial<{
  name: string;
  symbol: string | null;
  description: string | null;
  isActive: boolean;
}>;

export type ListUnitsQuery = PageQuery & {
  search?: string;
  isActive?: boolean;
};

export const unitService = {
  async list(query: ListUnitsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await unitRepository.list({
      search: query.search,
      isActive: query.isActive,
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const unit = await unitRepository.findById(id);
    if (!unit) {
      throw new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Unit not found");
    }
    return unit;
  },

  async create(input: CreateUnitInput) {
    const duplicate = await unitRepository.findByName(input.name);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_UNIT, "A unit with this name already exists");
    }

    try {
      return await unitRepository.create({
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        isActive: input.isActive,
      });
    } catch (error) {
      // Only a create/create race can reach here; map the unique violation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.DUPLICATE_UNIT, "A unit with this name already exists");
      }
      throw error;
    }
  },

  async update(id: string, input: UpdateUnitInput) {
    const unit = await unitRepository.findById(id);
    if (!unit) {
      throw new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Unit not found");
    }

    if (input.name !== undefined && input.name.toLowerCase() !== unit.name.toLowerCase()) {
      const duplicate = await unitRepository.findByName(input.name, id);
      if (duplicate) {
        throw new AppError(409, ErrorCode.DUPLICATE_UNIT, "A unit with this name already exists");
      }
    }

    return unitRepository.update(id, {
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      isActive: input.isActive,
    });
  },

  /**
   * Units are reusable master records referenced by ProductUnit
   * configurations and transfer history, so they are soft-deleted
   * (deactivated) instead of hard-deleted. Inactive units can no longer be
   * attached to products or transfers, but historical rows keep their names.
   */
  async remove(id: string) {
    const unit = await unitRepository.findById(id);
    if (!unit) {
      throw new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Unit not found");
    }

    await unitRepository.softDelete(id);
  },
};