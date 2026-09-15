import type { Request, Response } from "express";
import { purchaseOrderService, type CreatePOInput, type POListQuery, type UpdatePOInput } from "../../services/purchasing/purchase-order.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const purchaseOrderController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: POListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      supplierId: query.supplierId,
      status: query.status as POListQuery["status"],
      search: query.search,
    };
    const { items, meta } = await purchaseOrderService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await purchaseOrderService.create(req.body as CreatePOInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.update(req.params.id as string, req.body as UpdatePOInput);
    sendSuccess(res, data);
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await purchaseOrderService.cancel(req.params.id as string, actor);
    sendSuccess(res, data);
  }),

  markDelivered: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.markDelivered(req.params.id as string);
    sendSuccess(res, data);
  }),

  close: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.close(req.params.id as string);
    sendSuccess(res, data);
  }),
};