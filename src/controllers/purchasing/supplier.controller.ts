import type { Request, Response } from "express";
import { supplierService, type CreateSupplierInput, type SupplierListQuery, type UpdateSupplierInput } from "../../services/purchasing/supplier.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const supplierController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SupplierListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
    };
    const { items, meta } = await supplierService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await supplierService.create(req.body as CreateSupplierInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await supplierService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await supplierService.update(req.params.id as string, req.body as UpdateSupplierInput);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await supplierService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};