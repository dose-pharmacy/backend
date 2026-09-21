import type { Request, Response } from "express";
import type { StockTransactionType } from "@prisma/client";
import {
  narcoticReportService,
  type NarcoticActivityQuery,
  type NarcoticReportQuery,
} from "../../services/financials/reports/narcotic-report.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

/**
 * Query values arrive already coerced by the `validate` middleware (numbers,
 * Dates) — same pattern as the other financial report controllers. The
 * `as*` helpers keep the handlers tolerant of raw strings too.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

export const narcoticReportController = {
  getNarcoticReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: NarcoticReportQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      search: asString(query.search),
      productId: asString(query.productId),
      locationId: asString(query.locationId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
    };
    const { items, meta } = await narcoticReportService.getNarcoticReport(input);
    sendSuccess(res, items, { meta });
  }),

  getNarcoticActivity: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: NarcoticActivityQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      productId: asString(query.productId),
      locationId: asString(query.locationId),
      batchId: asString(query.batchId),
      movementType: asString(query.movementType) as StockTransactionType | undefined,
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
    };
    const { items, meta } = await narcoticReportService.getNarcoticActivity(input);
    sendSuccess(res, items, { meta });
  }),
};
