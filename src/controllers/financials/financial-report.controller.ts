import type { Request, Response } from "express";
import { getProfitMarginReport, getProfitabilityReport, getSlowMovingReport, getSalesReport, getSalesSummary, getSalesDetail, type ProfitMarginReportQuery, type ProfitabilityReportQuery, type SlowMovingReportQuery, type SalesReportQuery, type SalesDetailQuery } from "../../services/financials/financial-report.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const financialReportController = {
  getProfitMarginReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ProfitMarginReportQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      productGroupId: query.productGroupId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };
    const { items, meta } = await getProfitMarginReport(input);
    sendSuccess(res, items, { meta });
  }),

  getProfitabilityReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ProfitabilityReportQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      groupBy: query.groupBy as "BRAND" | "MANUFACTURER" | "PRODUCT_GROUP" | "PRODUCT" | undefined,
      productGroupId: query.productGroupId,
      manufacturerId: query.manufacturerId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };
    const { items, meta } = await getProfitabilityReport(input);
    sendSuccess(res, items, { meta });
  }),

  getSlowMovingReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SlowMovingReportQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      productGroupId: query.productGroupId,
      manufacturerId: query.manufacturerId,
      isFlagged: query.isFlagged === "true" ? true : query.isFlagged === "false" ? false : undefined,
      definitionType: query.definitionType as "DAYS_30" | "DAYS_60" | "DAYS_90" | "DAYS_180" | "CUSTOM" | undefined,
    };
    const { items, meta } = await getSlowMovingReport(input);
    sendSuccess(res, items, { meta });
  }),

  getSalesReport: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SalesReportQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      period: query.period as "DAILY" | "MONTHLY" | "ANNUAL" | undefined,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      productGroupId: query.productGroupId,
      manufacturerId: query.manufacturerId,
      locationId: query.locationId,
    };
    const { items, meta } = await getSalesReport(input);
    sendSuccess(res, items, { meta });
  }),

  getSalesSummary: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SalesReportQuery = {
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      locationId: query.locationId,
    };
    const data = await getSalesSummary(input);
    sendSuccess(res, data);
  }),

  getSalesDetail: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SalesDetailQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      saleId: query.saleId,
      productId: query.productId,
      cashierId: query.cashierId,
      locationId: query.locationId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };
    const { items, meta } = await getSalesDetail(input);
    sendSuccess(res, items, { meta });
  }),
};