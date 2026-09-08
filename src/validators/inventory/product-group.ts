import { z } from "zod";
import { idParamSchema, paginationQuerySchema, optionalQueryString, profitMarginSchema, requiredString } from "./common.js";

const fields = {
  name: requiredString(100, "Name"),
  description: z.string().trim().max(500).optional(),
  defaultProfitMargin: profitMarginSchema.optional(),
  isActive: z.boolean().optional(),
};

export const createProductGroupSchema = z.object(fields);

export const updateProductGroupSchema = z.object(fields).partial();

export const productGroupListQuerySchema = z
  .object({
    search: optionalQueryString(100),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export { idParamSchema as productGroupParamsSchema };
