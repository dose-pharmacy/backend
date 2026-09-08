import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "./common.js";

export const createExpiryActionSchema = z
  .object({
    batchId: uuidSchema,
    actionType: z.enum(["RETURN_TO_SUPPLIER", "CLEARANCE_SALE", "DISPOSE"]),
    quantity: z.number().positive("Quantity must be greater than zero").optional(),
    locationId: uuidSchema.optional(),
    supplierId: uuidSchema.optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    reason: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.actionType === "DISPOSE" || value.actionType === "RETURN_TO_SUPPLIER") {
      if (!value.quantity || value.quantity <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["quantity"],
          message: "Quantity is required and must be greater than zero for this action",
        });
      }
      if (!value.locationId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["locationId"],
          message: "Location is required for this action",
        });
      }
    }
    if (value.actionType === "CLEARANCE_SALE" && value.discountPercent !== undefined) {
      if (value.discountPercent < 0 || value.discountPercent > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["discountPercent"],
          message: "Discount percent must be between 0 and 100",
        });
      }
    }
  });

export const expiryActionListQuerySchema = z
  .object({
    batchId: uuidSchema.optional(),
    actionType: z.enum(["RETURN_TO_SUPPLIER", "CLEARANCE_SALE", "DISPOSE"]).optional(),
  })
  .merge(paginationQuerySchema);

export const batchIdParamSchema = z.object({
  batchId: uuidSchema,
});