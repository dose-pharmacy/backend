import type { Request, Response } from "express";
import { binCardService, type BinCardQuery } from "../../services/inventory/bin-card.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const binCardController = {
  getBinCard: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: BinCardQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      productId: query.productId!,
      locationId: query.locationId!,
      batchId: query.batchId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    };
    const result = await binCardService.getBinCard(input);
    sendSuccess(res, result);
  }),
};