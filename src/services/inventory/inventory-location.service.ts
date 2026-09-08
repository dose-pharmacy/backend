import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { inventoryLocationRepository } from "../../repositories/inventory/inventory-location.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateLocationInput = {
  name: string;
  description?: string;
  isActive?: boolean;
};

export type UpdateLocationInput = Partial<CreateLocationInput>;

export type ListLocationsQuery = PageQuery & {
  search?: string;
  isActive?: boolean;
};

export const inventoryLocationService = {
  async list(query: ListLocationsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { items, total } = await inventoryLocationRepository.list({
      search: query.search,
      isActive: query.isActive,
      skip,
      take,
    });
    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async getById(id: string) {
    const location = await inventoryLocationRepository.findById(id);
    if (!location) {
      throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
    }
    return location;
  },

  async create(input: CreateLocationInput) {
    const duplicate = await inventoryLocationRepository.findByName(input.name);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_LOCATION, "A location with this name already exists");
    }
    return inventoryLocationRepository.create({
      name: input.name,
      description: input.description,
      isActive: input.isActive,
    });
  },

  async update(id: string, input: UpdateLocationInput) {
    const location = await inventoryLocationRepository.findById(id);
    if (!location) {
      throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
    }

    if (input.name !== undefined && input.name.toLowerCase() !== location.name.toLowerCase()) {
      const duplicate = await inventoryLocationRepository.findByName(input.name, id);
      if (duplicate) {
        throw new AppError(409, ErrorCode.DUPLICATE_LOCATION, "A location with this name already exists");
      }
    }

    return inventoryLocationRepository.update(id, {
      name: input.name,
      description: input.description,
      isActive: input.isActive,
    });
  },

  async remove(id: string) {
    const location = await inventoryLocationRepository.findById(id);
    if (!location) {
      throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
    }

    const usages = await inventoryLocationRepository.countUsages(id);
    if (usages.stock > 0 || usages.transactions > 0) {
      throw new AppError(
        409,
        ErrorCode.LOCATION_IN_USE,
        "Cannot delete a location that holds stock or has transaction history",
        usages,
      );
    }

    await inventoryLocationRepository.deleteById(id);
  },
};
