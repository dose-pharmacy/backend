import { z } from "zod";
import { optionalQueryString, paginationQuerySchema, uuidSchema } from "../inventory/common.js";

/**
 * POS product selection. Only active products with at least one configured
 * selling unit (an active master unit with a non-null sellPrice) are
 * returned. `locationId` narrows the stock figures to one inventory
 * location; when omitted, stock is aggregated across all locations.
 */
export const posProductListQuerySchema = z
  .object({
    search: optionalQueryString(200),
    brand: optionalQueryString(100),
    productGroupId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
  })
  .merge(paginationQuerySchema);