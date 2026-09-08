import type { Request, Response } from "express";
import { expiryActionService, type CreateExpiryActionInput, type ListExpiryActionsQuery } from "../../services/inventory/expiry-action.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const expiryActionController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ListExpiryActionsQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      batchId: query.batchId,
      actionType: query.actionType as ListExpiryActionsQuery["actionType"],
    };
    const { items, meta } = await expiryActionService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await expiryActionService.create(req.body as CreateExpiryActionInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),
};