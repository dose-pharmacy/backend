import type { Request, Response } from "express";
import { healthService } from "../services/health.service.js";
import { asyncHandler } from "../utils/async-handler.js";

export const healthController = {
  live: asyncHandler((_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: healthService.liveness(),
    });
  }),

  ready: asyncHandler(async (_req: Request, res: Response) => {
    const result = await healthService.readiness();
    res.status(result.status === "ready" ? 200 : 503).json({
      success: result.status === "ready",
      data: result,
    });
  }),
};
