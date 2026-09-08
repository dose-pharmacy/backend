import { z } from "zod";
import {
  conversionFactorSchema,
  moneySchema,
  productIdParamSchema,
  quantitySchema,
  requiredString,
  unitParamsSchema,
  uuidSchema,
} from "./common.js";

export const createProductUnitSchema = z
  .object({
    name: requiredString(50, "Unit name"),
    conversionFactor: conversionFactorSchema,
    sellPrice: moneySchema.optional(),
    purchasePrice: moneySchema.optional(),
    isBaseUnit: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.isBaseUnit === true && value.conversionFactor !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conversionFactor"],
        message: "The base unit must have a conversion factor of exactly 1",
      });
    }
  });

export const updateProductUnitSchema = z
  .object({
    name: requiredString(50, "Unit name"),
    conversionFactor: conversionFactorSchema,
    sellPrice: moneySchema.nullable().optional(),
    purchasePrice: moneySchema.nullable().optional(),
  })
  .partial();

export const convertUnitsSchema = z.object({
  quantity: quantitySchema,
  fromUnitId: uuidSchema,
  toUnitId: uuidSchema,
});

export { productIdParamSchema, unitParamsSchema };
