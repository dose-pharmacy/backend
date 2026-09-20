import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";
import {
  getDashboardAttention,
  getDashboardRecentActivity,
  getDashboardSummary,
} from "../../services/dashboard/dashboard.service.js";

export const dashboardController = {
  /**
   * GET /api/v1/dashboard/summary
   * Returns a compact set of operational KPIs across sales, inventory,
   * purchasing and slow-moving. All queries run in parallel.
   */
  getSummary: asyncHandler(async (_req: Request, res: Response) => {
    const data = await getDashboardSummary();
    sendSuccess(res, data);
  }),

  /**
   * GET /api/v1/dashboard/attention
   * Returns small actionable lists (≤5 items per category) so the user
   * can see what needs immediate action.
   */
  getAttention: asyncHandler(async (_req: Request, res: Response) => {
    const data = await getDashboardAttention();
    sendSuccess(res, data);
  }),

  /**
   * GET /api/v1/dashboard/recent-activity
   * Returns the 10 most recent operational events (sales, goods receipts,
   * purchase orders) merged and sorted newest-first.
   */
  getRecentActivity: asyncHandler(async (_req: Request, res: Response) => {
    const data = await getDashboardRecentActivity();
    sendSuccess(res, data);
  }),
};
