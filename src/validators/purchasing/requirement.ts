import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema } from "../inventory/common.js";

const reasonCodeEnum = z.enum(["LOW_STOCK", "REORDER_ALERT", "MANUAL"]);
const requirementStatusEnum = z.enum(["OPEN", "ASSIGNED", "CLOSED"]);

export const createRequirementLineSchema = z.object({
  productId: uuidSchema,
  quantityNeeded: quantitySchema,
  reasonCode: reasonCodeEnum.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const createRequirementSchema = z.object({
  requiredBy: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(createRequirementLineSchema).min(1, "At least one line is required"),
});

export const updateRequirementSchema = z.object({
  requiredBy: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const addRequirementLineSchema = createRequirementLineSchema;

export const updateRequirementLineSchema = z.object({
  quantityNeeded: quantitySchema.optional(),
  reasonCode: reasonCodeEnum.optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  status: requirementStatusEnum.optional(),
});

export const assignSupplierToLineSchema = z.object({
  supplierId: uuidSchema,
});

export const requirementListQuerySchema = z
  .object({
    status: requirementStatusEnum.optional(),
    search: z.string().trim().max(200).optional(),
  })
  .merge(paginationQuerySchema);

export const requirementParamsSchema = z.object({
  id: uuidSchema,
});

export const requirementLineParamsSchema = z.object({
  lineId: uuidSchema,
});