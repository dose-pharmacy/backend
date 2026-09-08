import { z } from "zod";
import { idParamSchema, optionalQueryString, paginationQuerySchema, requiredString, uuidSchema } from "./common.js";

const fields = {
  name: requiredString(100, "Name"),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
};

export const createLocationSchema = z.object(fields);

export const updateLocationSchema = z.object(fields).partial();

export const locationListQuerySchema = z
  .object({
    search: optionalQueryString(100),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const locationStockQuerySchema = z
  .object({
    locationId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    search: optionalQueryString(200),
  })
  .merge(paginationQuerySchema);

export { idParamSchema as locationParamsSchema };
