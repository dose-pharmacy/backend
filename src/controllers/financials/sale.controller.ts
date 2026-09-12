import type { Request, Response } from "express";
import { saleService, type CreateSaleInput, type SaleListQuery, type UpdateSaleInput } from "../../services/financials/sale.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const saleController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SaleListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      status: query.status as "COMPLETED" | "VOIDED" | undefined,
      locationId: query.locationId,
      cashierId: query.cashierId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };
    const { items, meta } = await saleService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await saleService.create(req.body as CreateSaleInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await saleService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await saleService.update(req.params.id as string, req.body as UpdateSaleInput);
    sendSuccess(res, data);
  }),

  voidSale: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const { voidReason } = req.body;
    const data = await saleService.voidSale(req.params.id as string, voidReason, actor);
    sendSuccess(res, data);
  }),

  getDetail: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      saleId: query.saleId,
      productId: query.productId,
      cashierId: query.cashierId,
      locationId: query.locationId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };
    const { items, meta } = await saleService.getDetail(input);
    sendSuccess(res, items, { meta });
  }),
};