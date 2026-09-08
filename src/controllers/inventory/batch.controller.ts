import type { Request, Response } from "express";
import { batchService } from "../../services/inventory/batch.service.js";
import type { CreateBatchInput, ListBatchesQuery, UpdateBatchInput, BatchTransactionQuery } from "../../services/inventory/batch.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

type ListQuery = {
  page?: number;
  limit?: number;
  productId?: string;
  search?: string;
  locationId?: string;
  status?: string;
  expiresBefore?: string;
  expiresAfter?: string;
};

export const batchController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as ListQuery;
    const input: ListBatchesQuery = {
      page: query.page,
      limit: query.limit,
      productId: query.productId,
      search: query.search,
      expiresBefore: query.expiresBefore ? new Date(query.expiresBefore) : undefined,
      expiresAfter: query.expiresAfter ? new Date(query.expiresAfter) : undefined,
    };
    const { items, meta } = await batchService.list(input);
    sendSuccess(res, items, { meta });
  }),

  /** Batches belonging to one product (scoped by the URL param). */
  productBatches: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Pick<ListQuery, "page" | "limit" | "search">;
    const { items, meta } = await batchService.list({
      page: query.page,
      limit: query.limit,
      productId: req.params.productId as string,
      search: query.search,
    });
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await batchService.create(req.body as CreateBatchInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await batchService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await batchService.update(
      req.params.id as string,
      req.body as UpdateBatchInput,
    );
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await batchService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),

  getTransactions: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as BatchTransactionQuery;
    const input: BatchTransactionQuery = {
      page: query.page,
      limit: query.limit,
      transactionType: query.transactionType,
    };
    const { items, meta } = await batchService.getTransactions(req.params.id as string, input);
    sendSuccess(res, items, { meta });
  }),
};
