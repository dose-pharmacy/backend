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

export const createManufacturerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  contactInfo: optionalTrimmedText(500),
  isActive: z.boolean().optional(),
});

export const updateManufacturerSchema = createManufacturerSchema.partial();

export const manufacturerListQuerySchema = z
  .object({
    search: optionalTrimmedText(200),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const manufacturerParamsSchema = z.object({
  id: uuidSchema,
});