import type { Request, Response } from "express";
import { manufacturerService, type CreateManufacturerInput, type ManufacturerListQuery, type UpdateManufacturerInput } from "../../services/financials/manufacturer.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const manufacturerController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ManufacturerListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
    };
    const { items, meta } = await manufacturerService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await manufacturerService.create(req.body as CreateManufacturerInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await manufacturerService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await manufacturerService.update(req.params.id as string, req.body as UpdateManufacturerInput);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await manufacturerService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};