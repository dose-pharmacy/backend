import type { Request, Response } from "express";
import { getDashboardMetrics } from "../../services/inventory/dashboard.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const dashboardController = {
  getDashboard: asyncHandler(async (req: Request, res: Response) => {
    const thresholds = req.query.thresholds as string | undefined;
    const metrics = await getDashboardMetrics(req.auth!.user, thresholds);
    sendSuccess(res, { metrics });
  }),
};