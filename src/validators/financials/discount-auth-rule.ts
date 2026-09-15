import { z } from "zod";
import { paginationQuerySchema, uuidSchema, decimalNumber } from "../inventory/common.js";

const discountScopeEnum = z.enum(["ITEM", "BILL"]);

const positiveDiscountPctSchema = decimalNumber({
  minInclusive: 0,
  maxInclusive: 100,
  decimalPlaces: 2,
  message: "Discount percent must be between 0 and 100 with at most 2 decimal places",
});

export const createDiscountAuthRuleSchema = z.object({
  scope: discountScopeEnum,
  maxDiscountPct: positiveDiscountPctSchema,
  roleRequiredAbove: z.string().trim().max(50).optional(),
  isActive: z.boolean().optional(),
});

export const updateDiscountAuthRuleSchema = createDiscountAuthRuleSchema.partial();

export const discountAuthRuleListQuerySchema = z
  .object({
    scope: discountScopeEnum.optional(),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const discountAuthRuleParamsSchema = z.object({
  id: uuidSchema,
});