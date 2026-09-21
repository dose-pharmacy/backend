import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema } from "../inventory/common.js";

const reasonCodeEnum = z.enum(["LOW_STOCK", "REORDER_ALERT", "MANUAL"]);
const requirementStatusEnum = z.enum([
  "OPEN",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "CLOSED",
]);

export const createRequirementLineSchema = z.object({
  productId: uuidSchema,
  // Quantity is expressed in this unit and converted to base units by the
  // service. Omit to default to the product's base unit.
  unitId: uuidSchema.optional(),
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

// Fulfillment status is derived by the backend; clients may only edit the inputs
// (required quantity, unit, reason, notes). Any `status` sent is stripped by zod.
export const updateRequirementLineSchema = z.object({
  quantityNeeded: quantitySchema.optional(),
  // Changing the unit recomputes quantityNeededBase.
  unitId: uuidSchema.optional(),
  reasonCode: reasonCodeEnum.optional(),
  notes: z.string().trim().max(500).nullable().optional(),
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
