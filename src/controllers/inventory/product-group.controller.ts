import type { Request, Response } from "express";
import { productGroupService } from "../../services/inventory/product-group.service.js";
import type { CreateProductGroupInput, ListProductGroupsQuery } from "../../services/inventory/product-group.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: "true" | "false";
};

export const productGroupController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: ListProductGroupsQuery = {
      page: query.page,
      limit: query.limit,
      search: query.search,
      isActive: query.isActive !== undefined ? query.isActive === "true" : undefined,
    };
    const { items, meta } = await productGroupService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await productGroupService.create(req.body as CreateProductGroupInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await productGroupService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await productGroupService.update(
      req.params.id as string,
      req.body as CreateProductGroupInput,
    );
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await productGroupService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};
