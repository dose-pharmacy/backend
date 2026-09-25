import type { Request, Response } from "express";
import { creditSalesService, type CreditSalesQuery } from "../../services/financials/credit-sales.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim() !== "") return new Date(value);
  return undefined;
}

export const creditSalesController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: CreditSalesQuery = {
      page: typeof query.page === "string" ? Number(query.page) : undefined,
      limit: typeof query.limit === "string" ? Number(query.limit) : undefined,
      customerName: asString(query.customerName),
      customerPhone: asString(query.customerPhone),
      saleNumber: asString(query.saleNumber),
      status: asString(query.status) as CreditSalesQuery["status"],
      locationId: asString(query.locationId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
    };
    const { items, meta } = await creditSalesService.list(input);
    sendSuccess(res, items, { meta });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await creditSalesService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),
};