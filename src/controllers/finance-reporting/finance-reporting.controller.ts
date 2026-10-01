import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";
import {
  getFinanceDashboard,
  getFinanceReport,
  getFinanceTrends,
} from "../../services/finance-reporting/finance-reporting.service.js";
import type { TrendGranularity } from "../../services/finance-reporting/finance-reporting.types.js";

/** Query values are Dates/UUIDs once the `validate` middleware coerces them. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return new Date(value);
  }
  return undefined;
}

function asGranularity(value: unknown): TrendGranularity | undefined {
  return value === "DAY" || value === "MONTH" || value === "YEAR"
    ? value
    : undefined;
}

function readScope(query: Record<string, unknown>) {
  return {
    from: asDate(query.from),
    to: asDate(query.to),
    locationId: asString(query.locationId),
    productGroupId: asString(query.productGroupId),
  };
}

export const financeReportingController = {
  getDashboard: asyncHandler(async (_req: Request, res: Response) => {
    const data = await getFinanceDashboard();
    sendSuccess(res, data);
  }),

  getReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const data = await getFinanceReport({
      ...readScope(query),
      granularity: asGranularity(query.granularity),
    });
    sendSuccess(res, data);
  }),

  getTrends: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const data = await getFinanceTrends({
      ...readScope(query),
      granularity: asGranularity(query.granularity),
    });
    sendSuccess(res, data);
  }),
};
