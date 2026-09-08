import type { Request, Response } from "express";
import { locationStockService, type LocationStockQuery } from "../../services/inventory/location-stock.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const locationStockController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: LocationStockQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      locationId: query.locationId,
      productId: query.productId,
      search: query.search,
    };
    const { items, meta } = await locationStockService.list(input);
    sendSuccess(res, items, { meta });
  }),
};