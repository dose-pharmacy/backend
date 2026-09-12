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

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  contactPerson: optionalTrimmedText(200),
  email: optionalTrimmedText(200).refine(
    (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    "Email must be valid"
  ),
  phone: optionalTrimmedText(50),
  address: optionalTrimmedText(500),
  paymentTerms: optionalTrimmedText(500),
  isActive: z.boolean().optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial();

export const supplierListQuerySchema = z
  .object({
    search: optionalTrimmedText(200),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const supplierParamsSchema = z.object({
  id: uuidSchema,
});