import type { Request, Response } from "express";
import { inventoryLocationService } from "../../services/inventory/inventory-location.service.js";
import type { CreateLocationInput, ListLocationsQuery } from "../../services/inventory/inventory-location.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: "true" | "false";
};

export const locationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: ListLocationsQuery = {
      page: query.page,
      limit: query.limit,
      search: query.search,
      isActive: query.isActive !== undefined ? query.isActive === "true" : undefined,
    };
    const { items, meta } = await inventoryLocationService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await inventoryLocationService.create(req.body as CreateLocationInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await inventoryLocationService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await inventoryLocationService.update(
      req.params.id as string,
      req.body as CreateLocationInput,
    );
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await inventoryLocationService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};
