import type { Request, Response } from "express";
import { productService } from "../../services/inventory/product.service.js";
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from "../../services/inventory/product.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: number;
  limit?: number;
  search?: string;
  productGroupId?: string;
  brand?: string;
  isActive?: "true" | "false";
};

export const productController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: ListProductsQuery = {
      page: query.page,
      limit: query.limit,
      search: query.search,
      productGroupId: query.productGroupId,
      brand: query.brand,
      isActive: query.isActive !== undefined ? query.isActive === "true" : undefined,
    };
    const { items, meta } = await productService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await productService.create(req.body as CreateProductInput);
    sendSuccess(res, data, { status: 201 });
  }),

  /** Rich detail for the product detail page (units + stock summary). */
  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await productService.detail(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await productService.update(
      req.params.id as string,
      req.body as UpdateProductInput,
    );
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await productService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};
