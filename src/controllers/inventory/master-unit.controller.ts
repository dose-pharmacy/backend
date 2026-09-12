import type { Request, Response } from "express";
import { unitService, type CreateUnitInput, type ListUnitsQuery, type UpdateUnitInput } from "../../services/inventory/unit.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: "true" | "false";
};

export const masterUnitController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: ListUnitsQuery = {
      page: query.page,
      limit: query.limit,
      search: query.search,
      isActive: query.isActive !== undefined ? query.isActive === "true" : undefined,
    };
    const { items, meta } = await unitService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await unitService.create(req.body as CreateUnitInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await unitService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await unitService.update(
      req.params.id as string,
      req.body as UpdateUnitInput,
    );
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await unitService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};