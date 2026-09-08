import type { Request, Response } from "express";
import { stockService } from "../../services/inventory/stock.service.js";
import type { ListStockQuery, OpeningStockInput, StockAdjustmentInput } from "../../services/inventory/stock.service.js";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: number;
  limit?: number;
  productId?: string;
  batchId?: string;
  locationId?: string;
  search?: string;
};

function assertActor(req: Request) {
  if (!req.auth) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, "Authentication required");
  }
  return req.auth.user;
}

export const stockController = {
  listStock: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: ListStockQuery = {
      page: query.page,
      limit: query.limit,
      productId: query.productId,
      batchId: query.batchId,
      locationId: query.locationId,
      search: query.search,
    };
    const { items, meta } = await stockService.listStock(input);
    sendSuccess(res, items, { meta });
  }),

  openingStock: asyncHandler(async (req: Request, res: Response) => {
    const actor = assertActor(req);
    const data = await stockService.openingStock(
      req.body as OpeningStockInput,
      actor,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  stockAdjustment: asyncHandler(async (req: Request, res: Response) => {
    const actor = assertActor(req);
    const data = await stockService.adjustment(
      req.body as StockAdjustmentInput,
      actor,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  productStock: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const { items, meta } = await stockService.listProductStock(
      req.params.productId as string,
      { page: query.page, limit: query.limit },
    );
    sendSuccess(res, items, { meta });
  }),

  productTransactions: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const { items, meta } = await stockService.listProductTransactions(
      req.params.productId as string,
      { page: query.page, limit: query.limit },
    );
    sendSuccess(res, items, { meta });
  }),
};
