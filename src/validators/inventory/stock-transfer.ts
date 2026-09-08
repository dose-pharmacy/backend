import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "./common.js";

export const createTransferSchema = z
  .object({
    fromLocationId: uuidSchema,
    toLocationId: uuidSchema,
    transferDate: z.coerce.date().optional(),
    reason: z.string().trim().max(500).optional(),
    items: z
      .array(
        z.object({
          productId: uuidSchema,
          batchId: uuidSchema,
          quantity: z.number().positive("Quantity must be greater than zero"),
        }),
      )
      .min(1, "At least one item is required"),
  })
  .superRefine((value, ctx) => {
    if (value.fromLocationId === value.toLocationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toLocationId"],
        message: "Source and destination locations cannot be the same",
      });
    }
  });

export const updateTransferSchema = z.object({
  fromLocationId: uuidSchema.optional(),
  toLocationId: uuidSchema.optional(),
  transferDate: z.coerce.date().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["DRAFT", "PENDING", "COMPLETED", "CANCELLED"]).optional(),
});

export const transferListQuerySchema = z
  .object({
    status: z.enum(["DRAFT", "PENDING", "COMPLETED", "CANCELLED"]).optional(),
    fromLocationId: uuidSchema.optional(),
    toLocationId: uuidSchema.optional(),
  })
  .merge(paginationQuerySchema);

export const transferParamsSchema = z.object({
  id: uuidSchema,
});