import type { Request, Response } from "express";
import { expiryService, type ExpiryDashboardQuery } from "../../services/inventory/expiry.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const expiryController = {
  getDashboard: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ExpiryDashboardQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      thresholds: query.thresholds,
      locationId: query.locationId,
      productId: query.productId,
    };
    const result = await expiryService.getDashboard(input);
    sendSuccess(res, result);
  }),

  getBatchesByWindow: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ExpiryDashboardQuery & { windowStart: number; windowEnd: number } = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      thresholds: query.thresholds,
      locationId: query.locationId,
      productId: query.productId,
      windowStart: query.windowStart ? Number(query.windowStart) : 0,
      windowEnd: query.windowEnd ? Number(query.windowEnd) : 30,
    };
    const { items, meta } = await expiryService.getBatchesByWindow(input);
    sendSuccess(res, items, { meta });
  }),
};