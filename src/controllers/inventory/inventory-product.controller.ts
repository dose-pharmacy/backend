import type { Request, Response } from "express";
import { inventoryProductService, type InventoryProductListQuery } from "../../services/inventory/inventory-product.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const inventoryProductController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: InventoryProductListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      productGroupId: query.productGroupId,
      brand: query.brand,
      locationId: query.locationId,
      stockStatus: query.stockStatus as InventoryProductListQuery["stockStatus"],
      isActive: query.isActive !== undefined ? query.isActive === "true" : undefined,
    };
    const { items, meta } = await inventoryProductService.list(input);
    sendSuccess(res, items, { meta });
  }),
};