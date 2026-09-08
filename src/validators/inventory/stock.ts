import { StockDirection } from "@prisma/client";
import { z } from "zod";
import {
  optionalQueryString,
  paginationQuerySchema,
  productIdParamSchema,
  quantitySchema,
  uuidSchema,
} from "./common.js";

export const openingStockSchema = z.object({
  productId: uuidSchema,
  batchId: uuidSchema,
  locationId: uuidSchema,
  // Quantity is expressed in the given unit and converted to base units.
  quantity: quantitySchema,
  unitId: uuidSchema,
  notes: z.string().trim().max(500).optional(),
});

export const stockAdjustmentSchema = z.object({
  productId: uuidSchema,
  batchId: uuidSchema,
  locationId: uuidSchema,
  direction: z.nativeEnum(StockDirection),
  quantity: quantitySchema,
  unitId: uuidSchema,
  reason: z.string().trim().min(1, "A reason is required").max(500),
});

export const stockListQuerySchema = z
  .object({
    productId: uuidSchema.optional(),
    batchId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    search: optionalQueryString(200),
  })
  .merge(paginationQuerySchema);

export const productTransactionsQuerySchema = paginationQuerySchema;

export { productIdParamSchema, paginationQuerySchema };
