import { z } from "zod";
import {
  idParamSchema,
  optionalQueryString,
  paginationQuerySchema,
  productIdParamSchema,
  requiredString,
  thresholdSchema,
  uuidSchema,
} from "./common.js";

const optionalShortText = (max: number) => z.string().trim().max(max).optional();

export const createProductSchema = z.object({
  name: requiredString(200, "Name"),
  genericName: optionalShortText(200),
  brand: optionalShortText(100),
  sku: requiredString(64, "SKU"),
  productGroupId: uuidSchema,
  description: z.string().trim().max(2000).optional(),
  imageUrl: z.string().trim().url("Image URL must be valid").max(1000).optional(),
  minimumStock: thresholdSchema.optional(),
  reorderPoint: thresholdSchema.optional(),
  isActive: z.boolean().optional(),
});

export const updateProductSchema = z
  .object({
    name: requiredString(200, "Name"),
    genericName: optionalShortText(200),
    brand: optionalShortText(100),
    sku: requiredString(64, "SKU"),
    productGroupId: uuidSchema,
    description: z.string().trim().max(2000).optional(),
    imageUrl: z.string().trim().url("Image URL must be valid").max(1000).nullable().optional(),
    minimumStock: thresholdSchema.optional(),
    reorderPoint: thresholdSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .partial();

export const productListQuerySchema = z
  .object({
    search: optionalQueryString(200),
    productGroupId: uuidSchema.optional(),
    brand: optionalQueryString(100),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export { idParamSchema as productParamsSchema, productIdParamSchema };
