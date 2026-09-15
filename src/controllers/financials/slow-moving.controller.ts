import type { Request, Response } from "express";
import { slowMovingConfigService, type CreateSlowMovingConfigInput, type SlowMovingConfigListQuery, type UpdateSlowMovingConfigInput } from "../../services/financials/slow-moving.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const slowMovingConfigController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SlowMovingConfigListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      productId: query.productId,
      isFlagged: query.isFlagged === "true" ? true : query.isFlagged === "false" ? false : undefined,
      definitionType: query.definitionType as "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM" | undefined,
    };
    const { items, meta } = await slowMovingConfigService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await slowMovingConfigService.create(req.body as CreateSlowMovingConfigInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await slowMovingConfigService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  getByProductId: asyncHandler(async (req: Request, res: Response) => {
    const data = await slowMovingConfigService.getByProductId(req.params.productId as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await slowMovingConfigService.update(req.params.id as string, req.body as UpdateSlowMovingConfigInput);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await slowMovingConfigService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),

  evaluate: asyncHandler(async (req: Request, res: Response) => {
    const data = await slowMovingConfigService.evaluateSlowMoving();
    sendSuccess(res, data);
  }),

  getFlagged: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    };
    const { items, meta } = await slowMovingConfigService.getFlaggedProducts(input);
    sendSuccess(res, items, { meta });
  }),
};