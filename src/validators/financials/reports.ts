import { z } from "zod";
import { paginationQuerySchema, optionalUuidQuery } from "../inventory/common.js";

export const profitMarginReportQuerySchema = z
  .object({
    productGroupId: optionalUuidQuery(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

export const profitabilityReportQuerySchema = z
  .object({
    groupBy: z.enum(["BRAND", "MANUFACTURER", "PRODUCT_GROUP", "PRODUCT"]).optional(),
    productGroupId: optionalUuidQuery(),
    manufacturerId: optionalUuidQuery(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

export const slowMovingReportQuerySchema = z
  .object({
    productGroupId: optionalUuidQuery(),
    manufacturerId: optionalUuidQuery(),
    isFlagged: z.enum(["true", "false"]).optional(),
    definitionType: z.enum(["DAYS_30", "DAYS_60", "DAYS_90", "DAYS_180", "CUSTOM"]).optional(),
  })
  .merge(paginationQuerySchema);

export const salesReportQuerySchema = z
  .object({
    period: z.enum(["DAILY", "MONTHLY", "ANNUAL"]).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    productGroupId: optionalUuidQuery(),
    manufacturerId: optionalUuidQuery(),
    locationId: optionalUuidQuery(),
  })
  .merge(paginationQuerySchema);

export const salesDetailQuerySchema = z
  .object({
    saleId: optionalUuidQuery(),
    productId: optionalUuidQuery(),
    cashierId: optionalUuidQuery(),
    locationId: optionalUuidQuery(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);