import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "../inventory/common.js";

export const profitMarginReportQuerySchema = z
  .object({
    productGroupId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

export const profitabilityReportQuerySchema = z
  .object({
    groupBy: z.enum(["BRAND", "MANUFACTURER", "PRODUCT_GROUP", "PRODUCT"]).optional(),
    productGroupId: uuidSchema.optional(),
    manufacturerId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

export const slowMovingReportQuerySchema = z
  .object({
    productGroupId: uuidSchema.optional(),
    manufacturerId: uuidSchema.optional(),
    isFlagged: z.enum(["true", "false"]).optional(),
    definitionType: z.enum(["DAYS_30", "DAYS_60", "DAYS_90", "DAYS_180", "CUSTOM"]).optional(),
  })
  .merge(paginationQuerySchema);

export const salesReportQuerySchema = z
  .object({
    period: z.enum(["DAILY", "MONTHLY", "ANNUAL"]).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    productGroupId: uuidSchema.optional(),
    manufacturerId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
  })
  .merge(paginationQuerySchema);

export const salesDetailQuerySchema = z
  .object({
    saleId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    cashierId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);