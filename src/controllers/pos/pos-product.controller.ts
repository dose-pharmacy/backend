import type { Request, Response } from "express";
import {
  posProductService,
  type PosProductListQuery,
} from "../../services/pos/pos-product.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: string;
  limit?: string;
  search?: string;
  brand?: string;
  productGroupId?: string;
  locationId?: string;
};

export const posProductController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: PosProductListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      brand: query.brand,
      productGroupId: query.productGroupId,
      locationId: query.locationId,
    };
    const { items, meta } = await posProductService.listProducts(input);
    sendSuccess(res, items, { meta });
  }),
};