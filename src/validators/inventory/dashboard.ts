import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "./common.js";

export const dashboardQuerySchema = z.object({
  thresholds: z.string().optional(),
});

export const inventoryProductListQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    productGroupId: uuidSchema.optional(),
    brand: z.string().trim().max(100).optional(),
    locationId: uuidSchema.optional(),
    stockStatus: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"]).optional(),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const expiryDashboardQuerySchema = z.object({
  thresholds: z.string().optional(),
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
}).merge(paginationQuerySchema);

export const binCardQuerySchema = z.object({
  productId: uuidSchema,
  locationId: uuidSchema,
  batchId: uuidSchema.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).merge(paginationQuerySchema);

export const locationStockQuerySchema = z.object({
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
  search: z.string().trim().max(200).optional(),
}).merge(paginationQuerySchema);

export const reorderConfigSchema = z.object({
  minimumStockLevel: z.number().min(0).max(99999999999.999),
  reorderPoint: z.number().min(0).max(99999999999.999),
  leadTimeDays: z.number().int().positive().max(365).optional(),
  reorderQuantity: z.number().min(0).max(99999999999.999),
  useSalesVelocity: z.boolean().optional(),
  bufferPercentage: z.number().min(0).max(100).optional(),
});