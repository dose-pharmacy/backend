import type { Request, Response } from "express";
import {
  purchaseOrderService,
  type CreatePOInput,
  type CreatePOFromRequirementInput,
  type POListQuery,
  type UpdatePOInput,
  type UpdatePOItemInput,
} from "../../services/purchasing/purchase-order.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const purchaseOrderController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: POListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      supplierId: query.supplierId as string | undefined,
      status: query.status as POListQuery["status"],
      paymentStatus: query.paymentStatus as POListQuery["paymentStatus"],
      search: query.search as string | undefined,
      receivable: typeof query.receivable === "boolean" ? query.receivable : undefined,
      invoiceable: typeof query.invoiceable === "boolean" ? query.invoiceable : undefined,
      includeItems: typeof query.includeItems === "boolean" ? query.includeItems : undefined,
    };
    const { items, meta, summary } = await purchaseOrderService.list(input);
    sendSuccess(res, items, { meta, summary });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await purchaseOrderService.create(req.body as CreatePOInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  createFromRequirement: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await purchaseOrderService.createFromRequirement(
      req.body as CreatePOFromRequirementInput,
      actor,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as { receivableItems?: boolean; invoiceableItems?: boolean };
    const data = await purchaseOrderService.getById(req.params.id as string, {
      receivableItems: query.receivableItems === true,
      invoiceableItems: query.invoiceableItems === true,
    });
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.update(
      req.params.id as string,
      req.body as UpdatePOInput,
      req.auth?.user,
    );
    sendSuccess(res, data);
  }),

  updateItem: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.updateItem(
      req.params.itemId as string,
      req.body as UpdatePOItemInput,
    );
    sendSuccess(res, data);
  }),

  removeItem: asyncHandler(async (req: Request, res: Response) => {
    await purchaseOrderService.removeItem(req.params.itemId as string);
    sendSuccess(res, null);
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await purchaseOrderService.cancel(req.params.id as string, actor);
    sendSuccess(res, data);
  }),

  acceptShortage: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.acceptShortage(
      req.params.itemId as string,
      req.body as { quantityShort?: number; shortReason?: string | null },
    );
    sendSuccess(res, data, { status: 201 });
  }),

  close: asyncHandler(async (req: Request, res: Response) => {
    const data = await purchaseOrderService.close(req.params.id as string, req.auth?.user);
    sendSuccess(res, data);
  }),
};
