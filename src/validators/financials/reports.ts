import { z } from "zod";
import { paginationQuerySchema, optionalUuidQuery } from "../inventory/common.js";
import { REPORT_PERIODS } from "../../utils/reporting/period.js";
import {
  SALES_SORT_FIELDS,
  SALES_DETAIL_SORT_FIELDS,
} from "../../services/financials/reports/sales-report.service.js";
import { PROFITABILITY_SORT_FIELDS } from "../../services/financials/reports/profitability-report.service.js";
import { SLOW_MOVING_REPORT_SORT_FIELDS } from "../../services/financials/reports/slow-moving-report.service.js";
import { PROFIT_MARGIN_SORT_FIELDS } from "../../services/financials/financial-report.service.js";

export const sortOrderQuerySchema = z.enum(["asc", "desc"]).optional();

export const dateFromQuerySchema = z.coerce.date().optional();
export const dateToQuerySchema = z.coerce.date().optional();

/**
 * Enforces `dateFrom <= dateTo` for every report endpoint. The service layer
 * repeats the check (defence in depth) but rejecting here gives the client a
 * clean 422 before any query runs.
 */
function dateRangeRefinement<T extends { dateFrom?: Date; dateTo?: Date }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  if (
    value.dateFrom &&
    value.dateTo &&
    value.dateFrom.getTime() > value.dateTo.getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dateFrom"],
      message: "`dateFrom` must be on or before `dateTo`",
    });
  }
}

export const salesTrendQuerySchema = z
  .object({
    period: z.enum(REPORT_PERIODS).optional(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
    locationId: optionalUuidQuery(),
  })
  .superRefine(dateRangeRefinement);

export const profitMarginReportQuerySchema = z
  .object({
    productGroupId: optionalUuidQuery(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
    sortBy: z.enum(PROFIT_MARGIN_SORT_FIELDS).optional(),
    sortOrder: sortOrderQuerySchema,
  })
  .merge(paginationQuerySchema)
  .superRefine(dateRangeRefinement);

export const profitMarginSummaryQuerySchema = z
  .object({
    productGroupId: optionalUuidQuery(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
  })
  .superRefine(dateRangeRefinement);

export const profitabilityReportQuerySchema = z
  .object({
    groupBy: z
      .enum(["BRAND", "MANUFACTURER", "PRODUCT_GROUP", "PRODUCT"])
      .optional(),
    productGroupId: optionalUuidQuery(),
    manufacturerId: optionalUuidQuery(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
    sortBy: z.enum(PROFITABILITY_SORT_FIELDS).optional(),
    sortOrder: sortOrderQuerySchema,
  })
  .merge(paginationQuerySchema)
  .superRefine(dateRangeRefinement);

export const profitabilitySummaryQuerySchema = z
  .object({
    groupBy: z
      .enum(["BRAND", "MANUFACTURER", "PRODUCT_GROUP", "PRODUCT"])
      .optional(),
    productGroupId: optionalUuidQuery(),
    manufacturerId: optionalUuidQuery(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
  })
  .superRefine(dateRangeRefinement);

export const slowMovingReportQuerySchema = z
  .object({
    productGroupId: optionalUuidQuery(),
    manufacturerId: optionalUuidQuery(),
    isFlagged: z.enum(["true", "false"]).optional(),
    definitionType: z
      .enum(["DAYS_30", "DAYS_60", "DAYS_90", "DAYS_180", "CUSTOM"])
      .optional(),
    sortBy: z.enum(SLOW_MOVING_REPORT_SORT_FIELDS).optional(),
    sortOrder: sortOrderQuerySchema,
  })
  .merge(paginationQuerySchema);

export const salesReportQuerySchema = z
  .object({
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
    locationId: optionalUuidQuery(),
    sortBy: z.enum(SALES_SORT_FIELDS).optional(),
    sortOrder: sortOrderQuerySchema,
  })
  .merge(paginationQuerySchema)
  .superRefine(dateRangeRefinement);

export const salesSummaryQuerySchema = z
  .object({
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
    locationId: optionalUuidQuery(),
  })
  .superRefine(dateRangeRefinement);

export const salesDetailQuerySchema = z
  .object({
    saleId: optionalUuidQuery(),
    productId: optionalUuidQuery(),
    cashierId: optionalUuidQuery(),
    locationId: optionalUuidQuery(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
    sortBy: z.enum(SALES_DETAIL_SORT_FIELDS).optional(),
    sortOrder: sortOrderQuerySchema,
  })
  .merge(paginationQuerySchema)
  .superRefine(dateRangeRefinement);