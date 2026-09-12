import type { Request, Response } from "express";
import { purchaseReturnService, type CreatePurchaseReturnInput, type PurchaseReturnListQuery } from "../../services/purchasing/purchase-return.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const purchaseReturnController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: PurchaseReturnListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      supplierId: query.supplierId,
      productId: query.productId,
      reason: query.reason as PurchaseReturnListQuery["reason"],
    };
    const { items, meta } = await purchaseReturnService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await purchaseReturnService.create(req.body as CreatePurchaseReturnInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseReturnService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await purchaseReturnService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};