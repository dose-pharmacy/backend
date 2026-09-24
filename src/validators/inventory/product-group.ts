import { z } from "zod";
import { idParamSchema, paginationQuerySchema, optionalQueryString, profitMarginSchema, requiredString } from "./common.js";

const fields = {
  name: requiredString(100, "Name"),
  description: z.string().trim().max(500).optional(),
  defaultProfitMargin: profitMarginSchema.optional(),
  isActive: z.boolean().optional(),
};

export const createProductGroupSchema = z.object(fields);

/**
 * Update schema is tolerant of the full create payload being echoed back:
 * - `null` clears description (persisted as NULL)
 * - `isActive` accepts the strings "true"/"false" and `null`
 * - `defaultProfitMargin` accepts numeric strings and `null`
 * This keeps name-only updates from being rejected.
 */
export const updateProductGroupSchema = z.object({
  name: requiredString(100, "Name").optional(),
  description: z.string().trim().max(500).nullable().optional(),
  defaultProfitMargin: z.preprocess(
    (value) => {
      if (value === null || value === "") {
        return undefined;
      }
      return typeof value === "string" ? Number(value) : value;
    },
    profitMarginSchema.optional(),
  ),
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

export const productGroupListQuerySchema = z
  .object({
    search: optionalQueryString(100),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export { idParamSchema as productGroupParamsSchema };
