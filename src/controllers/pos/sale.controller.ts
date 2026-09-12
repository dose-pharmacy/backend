import type { Request, Response } from "express";
import {
  saleService,
  type CreateSaleInput,
  type ListSalesQuery,
} from "../../services/pos/sale.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

function assertActor(req: Request) {
  return req.auth!.user;
}

export const saleController = {
  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = assertActor(req);
    const data = await saleService.complete(
      req.body as CreateSaleInput,
      actor,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await saleService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ListSalesQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      status: query.status as ListSalesQuery["status"],
      locationId: query.locationId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      search: query.search,
    };
    const { items, meta } = await saleService.list(input);
    sendSuccess(res, items, { meta });
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const actor = assertActor(req);
    const data = await saleService.cancel(
      req.params.id as string,
      actor,
      (req.body as { reason?: string } | undefined)?.reason,
    );
    sendSuccess(res, data);
  }),
};