import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "../inventory/common.js";

function optionalTrimmedText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));
}

export const createGenericProductSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: optionalTrimmedText(1000),
});

export const updateGenericProductSchema = createGenericProductSchema.partial();

export const genericProductListQuerySchema = z
  .object({
    search: optionalTrimmedText(200),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const genericProductParamsSchema = z.object({
  id: uuidSchema,
});