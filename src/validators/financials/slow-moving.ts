import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "../inventory/common.js";

const definitionTypeEnum = z.enum(["DAYS_30", "DAYS_60", "DAYS_90", "DAYS_180", "CUSTOM"]);

export const createSlowMovingConfigSchema = z.object({
  productId: uuidSchema,
  definitionType: definitionTypeEnum,
  customDays: z.number().int().positive().max(365).optional(),
});

export const updateSlowMovingConfigSchema = z.object({
  definitionType: definitionTypeEnum.optional(),
  customDays: z.number().int().positive().max(365).nullable().optional(),
});

export const slowMovingConfigListQuerySchema = z
  .object({
    productId: uuidSchema.optional(),
    isFlagged: z.enum(["true", "false"]).optional(),
    definitionType: definitionTypeEnum.optional(),
  })
  .merge(paginationQuerySchema);

export const slowMovingConfigParamsSchema = z.object({
  id: uuidSchema,
});

export const slowMovingConfigProductParamsSchema = z.object({
  productId: uuidSchema,
});