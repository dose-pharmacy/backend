import { z } from "zod";
import { idParamSchema, optionalQueryString, paginationQuerySchema, requiredString, uuidSchema } from "./common.js";

const fields = {
  name: requiredString(100, "Name"),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
};

export const createLocationSchema = z.object(fields);

/**
 * Update schema is tolerant of the full create payload being echoed back:
 * - `null` clears description (persisted as NULL)
 * - `isActive` accepts the strings "true"/"false" and `null`
 * This keeps name-only updates from being rejected.
 */
export const updateLocationSchema = z.object({
  name: requiredString(100, "Name").optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.preprocess(
    (value) => {
      if (value === null) {
        return undefined;
      }
      return value === "true" ? true : value === "false" ? false : value;
    },
    z.boolean().optional(),
  ),
});

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
