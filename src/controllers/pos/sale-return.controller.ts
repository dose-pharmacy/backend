import type { Request, Response } from "express";
import {
  saleReturnService,
  type CreateSaleReturnInput,
  type ListSaleReturnsQuery,
  type SaleReturnItemInput,
} from "../../services/pos/sale-return.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

function assertActor(req: Request) {
  return req.auth!.user;
}

export const saleReturnController = {
  /**
   * Return screen for a sale: original quantities, what has already been
   * returned, what is still returnable, original prices/net amounts and the
   * batches each line was sold from.
   */
  getReturnInfo: asyncHandler(async (req: Request, res: Response) => {
    const data = await saleReturnService.getReturnInfo(req.params.id as string);
    sendSuccess(res, data);
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = assertActor(req);
    const body = req.body as CreateSaleReturnInput;
    const data = await saleReturnService.createReturn(
      req.params.id as string,
      {
        items: (body.items as SaleReturnItemInput[]) ?? [],
        refundMethod: body.refundMethod,
        refundReference: body.refundReference,
        reason: body.reason,
        notes: body.notes,
        idempotencyKey: body.idempotencyKey,
      },
      actor,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await saleReturnService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ListSaleReturnsQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      saleId: query.saleId,
      locationId: query.locationId,
      productId: query.productId,
      refundMethod: query.refundMethod as ListSaleReturnsQuery["refundMethod"],
      restock: query.restock as ListSaleReturnsQuery["restock"],
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };
    const { items, meta, summary } = await saleReturnService.list(input);
    sendSuccess(res, items, { meta, summary });
  }),
};