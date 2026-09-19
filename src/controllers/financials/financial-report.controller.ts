import type { Request, Response } from "express";
import {
  getProfitMarginReport,
  getProfitMarginSummary,
  getProfitabilityReport,
  getProfitabilitySummary,
  getSalesDetail,
  getSalesReport,
  getSalesSummary,
  getSalesTrend,
  getSlowMovingReport,
  type ProfitMarginReportQuery,
  type ProfitMarginSummaryQuery,
  type ProfitabilityGroupBy,
  type ProfitabilityReportQuery,
  type ProfitabilitySummaryQuery,
  type SalesDetailQuery,
  type SalesReportQuery,
  type SlowMovingReportQuery,
} from "../../services/financials/financial-report.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";
import type { ReportPeriod } from "../../utils/reporting/period.js";

/**
 * Query values arrive either as raw strings (when a route has no schema) or
 * already coerced by the `validate` middleware (numbers / Dates). These tiny
 * helpers normalise both without leaking `any` into the handlers.
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
    return new Date(value);
  }
  return undefined;
}

export const financialReportController = {
  getSalesTrend: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const data = await getSalesTrend(
      {
        dateFrom: asDate(query.dateFrom),
        dateTo: asDate(query.dateTo),
        locationId: asString(query.locationId),
      },
      (asString(query.period) as ReportPeriod | undefined) ?? "DAILY",
    );
    sendSuccess(res, data);
  }),

  getSalesReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: SalesReportQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
      locationId: asString(query.locationId),
      sortBy: asString(query.sortBy),
      sortOrder: asString(query.sortOrder),
    };
    const { items, meta } = await getSalesReport(input);
    sendSuccess(res, items, { meta });
  }),

  getSalesSummary: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const data = await getSalesSummary({
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
      locationId: asString(query.locationId),
    });
    sendSuccess(res, data);
  }),

  getSalesDetail: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: SalesDetailQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      saleId: asString(query.saleId),
      productId: asString(query.productId),
      cashierId: asString(query.cashierId),
      locationId: asString(query.locationId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
      sortBy: asString(query.sortBy),
      sortOrder: asString(query.sortOrder),
    };
    const { items, meta } = await getSalesDetail(input);
    sendSuccess(res, items, { meta });
  }),

  getProfitabilityReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: ProfitabilityReportQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      groupBy: asString(query.groupBy) as ProfitabilityGroupBy | undefined,
      productGroupId: asString(query.productGroupId),
      manufacturerId: asString(query.manufacturerId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
      sortBy: asString(query.sortBy),
      sortOrder: asString(query.sortOrder),
    };
    const { items, meta } = await getProfitabilityReport(input);
    sendSuccess(res, items, { meta });
  }),

  getProfitabilitySummary: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: ProfitabilitySummaryQuery = {
      groupBy: asString(query.groupBy) as ProfitabilityGroupBy | undefined,
      productGroupId: asString(query.productGroupId),
      manufacturerId: asString(query.manufacturerId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
    };
    const data = await getProfitabilitySummary(input);
    sendSuccess(res, data);
  }),

  getProfitMarginReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: ProfitMarginReportQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      productGroupId: asString(query.productGroupId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
      sortBy: asString(query.sortBy),
      sortOrder: asString(query.sortOrder),
    };
    const { items, meta } = await getProfitMarginReport(input);
    sendSuccess(res, items, { meta });
  }),

  getProfitMarginSummary: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: ProfitMarginSummaryQuery = {
      productGroupId: asString(query.productGroupId),
      dateFrom: asDate(query.dateFrom),
      dateTo: asDate(query.dateTo),
    };
    const data = await getProfitMarginSummary(input);
    sendSuccess(res, data);
  }),

  getSlowMovingReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: SlowMovingReportQuery = {
      page: asNumber(query.page),
      limit: asNumber(query.limit),
      productGroupId: asString(query.productGroupId),
      manufacturerId: asString(query.manufacturerId),
      isFlagged:
        query.isFlagged === "true" ? true : query.isFlagged === "false" ? false : undefined,
      definitionType: asString(query.definitionType) as
        | "DAYS_30"
        | "DAYS_60"
        | "DAYS_90"
        | "DAYS_180"
        | "CUSTOM"
        | undefined,
      sortBy: asString(query.sortBy),
      sortOrder: asString(query.sortOrder),
    };
    const { items, meta } = await getSlowMovingReport(input);
    sendSuccess(res, items, { meta });
  }),
};
