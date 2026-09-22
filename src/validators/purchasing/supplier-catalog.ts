import { z } from "zod";
import { optionalQueryString, optionalUuidQuery, paginationQuerySchema, uuidSchema } from "../inventory/common.js";

/** Params for /suppliers/:supplierId/products(+/batches). */
export const supplierProductParamsSchema = z.object({
  supplierId: uuidSchema,
  productId: uuidSchema,
});

export const supplierIdParamsSchema = z.object({
  supplierId: uuidSchema,
});

export const supplierProductListQuerySchema = z
  .object({
    search: optionalQueryString(200),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const supplierProductBatchQuerySchema = z.object({
  inStock: z.enum(["true", "false"]).optional(),
  excludeExpired: z.enum(["true", "false"]).optional(),
  locationId: optionalUuidQuery(),
});
