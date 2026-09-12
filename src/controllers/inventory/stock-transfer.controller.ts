import type { Request, Response } from "express";
import {
  stockTransferService,
  type CreateTransferInput,
  type ListTransfersQuery,
  type TransferItemInput,
  type UpdateTransferInput,
  type UpdateTransferItemInput,
} from "../../services/inventory/stock-transfer.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const stockTransferController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ListTransfersQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      status: query.status as ListTransfersQuery["status"],
      fromLocationId: query.fromLocationId,
      toLocationId: query.toLocationId,
    };
    const { items, meta } = await stockTransferService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await stockTransferService.create(req.body as CreateTransferInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await stockTransferService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await stockTransferService.update(req.params.id as string, req.body as UpdateTransferInput);
    sendSuccess(res, data);
  }),

  addItem: asyncHandler(async (req: Request, res: Response) => {
    const data = await stockTransferService.addItem(
      req.params.transferId as string,
      req.body as TransferItemInput,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  updateItem: asyncHandler(async (req: Request, res: Response) => {
    const data = await stockTransferService.updateItem(
      req.params.transferId as string,
      req.params.itemId as string,
      req.body as UpdateTransferItemInput,
    );
    sendSuccess(res, data);
  }),

  removeItem: asyncHandler(async (req: Request, res: Response) => {
    await stockTransferService.removeItem(
      req.params.transferId as string,
      req.params.itemId as string,
    );
    sendSuccess(res, null);
  }),

  complete: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await stockTransferService.complete(req.params.id as string, actor);
    sendSuccess(res, data);
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await stockTransferService.cancel(req.params.id as string, actor);
    sendSuccess(res, data);
  }),
};