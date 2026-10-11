import { z } from "zod";
import {
  optionalQueryString,
  paginationQuerySchema,
  quantitySchema,
  uuidSchema,
} from "./common.js";

/**
 * Transfer line item. `quantity` is the user-entered quantity in `unitId`;
 * `baseQuantity` is server-calculated (quantity x ProductUnit conversion
 * factor at entry time) and persisted for auditability. For create/update
 * requests baseQuantity is normally NOT supplied — the server computes it.
 */
export const transferItemSchema = z.object({
  productId: uuidSchema,
  batchId: uuidSchema,
  unitId: uuidSchema,
  quantity: quantitySchema,
});

export const createTransferSchema = z
  .object({
    fromLocationId: uuidSchema,
    toLocationId: uuidSchema,
    transferDate: z.coerce.date().optional(),
    reason: z.string().trim().max(500).optional(),
    // A draft may start empty and gain items through the item endpoints.
    items: z.array(transferItemSchema).optional(),
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

/**
 * Generic transfer update. `status` is intentionally NOT accepted — state
 * transitions happen only through POST /transfers/:id/complete and
 * POST /transfers/:id/cancel.
 */
export const updateTransferSchema = z
  .object({
    fromLocationId: uuidSchema.optional(),
    toLocationId: uuidSchema.optional(),
    transferDate: z.coerce.date().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  // passthrough so the superRefine below can see (and reject) a `status`
  // key even though it is not part of the schema.
  .passthrough()
  .superRefine((value, ctx) => {
    if ("status" in value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message:
          "Status cannot be changed through this endpoint; use POST /transfers/:id/complete or POST /transfers/:id/cancel",
      });
    }
  });

export const createTransferItemSchema = transferItemSchema;

export const updateTransferItemSchema = z
  .object({
    unitId: uuidSchema.optional(),
    quantity: quantitySchema.optional(),
  })
  .refine((value) => value.unitId !== undefined || value.quantity !== undefined, {
    message: "At least one of unitId or quantity must be provided",
  });

export const transferListQuerySchema = z
  .object({
    status: z.enum(["DRAFT", "PENDING", "COMPLETED", "CANCELLED"]).optional(),
    fromLocationId: uuidSchema.optional(),
    toLocationId: uuidSchema.optional(),
    // Free-text search across the source/destination location names and the
    // name of any medicine/product on the transfer's line items. A transfer has
    // no human-readable number, so locations + products are the searchable
    // surface. `some` compiles to EXISTS, so a transfer with several matching
    // items is still returned exactly once.
    search: optionalQueryString(200),
  })
  .merge(paginationQuerySchema);

export const transferParamsSchema = z.object({
  id: uuidSchema,
});

export const transferItemParamsSchema = z.object({
  transferId: uuidSchema,
  itemId: uuidSchema,
});

export const transferItemCreateParamsSchema = z.object({
  transferId: uuidSchema,
});