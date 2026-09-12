import type { Request, Response } from "express";
import { genericProductService, type CreateGenericProductInput, type GenericProductListQuery, type UpdateGenericProductInput } from "../../services/financials/generic-product.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const genericProductController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: GenericProductListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
    };
    const { items, meta } = await genericProductService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await genericProductService.create(req.body as CreateGenericProductInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await genericProductService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await genericProductService.update(req.params.id as string, req.body as UpdateGenericProductInput);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await genericProductService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};