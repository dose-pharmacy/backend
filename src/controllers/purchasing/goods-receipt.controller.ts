import type { Request, Response } from "express";
import { goodsReceiptService, type CreateGRInput, type GRListQuery, type ResolveGRInput } from "../../services/purchasing/goods-receipt.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const goodsReceiptController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: GRListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      purchaseOrderId: query.purchaseOrderId,
      status: query.status as GRListQuery["status"],
    };
    const { items, meta } = await goodsReceiptService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const input: CreateGRInput = {
      ...req.body,
      purchaseOrderId: req.params.id as string,
    };
    const data = await goodsReceiptService.create(input, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await goodsReceiptService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  resolve: asyncHandler(async (req: Request, res: Response) => {
    const data = await goodsReceiptService.resolve(req.params.id as string, req.body as ResolveGRInput);
    sendSuccess(res, data);
  }),

  confirm: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await goodsReceiptService.confirm(req.params.id as string, actor);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await goodsReceiptService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};