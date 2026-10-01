import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema, moneySchema, decimalNumber } from "../inventory/common.js";

const returnReasonEnum = z.enum(["EXPIRED", "DAMAGED", "INCORRECT_DELIVERY"]);

const positiveMoneySchema = decimalNumber({
  minInclusive: 0.01,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be greater than zero and at most 9999999999.99 with at most 2 decimal places",
});

export const createPurchaseReturnSchema = z.object({
  supplierId: uuidSchema,
  productId: uuidSchema,
  // The PO item whose received goods are being returned. Required: the return
  // value is derived from its unit cost and the returnable quantity is capped
  // by its received quantity minus previous returns.
  purchaseOrderItemId: uuidSchema,
  batchId: uuidSchema.optional(),
  locationId: uuidSchema,
  reason: returnReasonEnum,
  quantity: quantitySchema,
  unitId: uuidSchema.optional(),
  // Optional convenience echo; the authoritative value is derived server-side
  // from the PO item cost and must match when supplied.
  unitCost: positiveMoneySchema.optional(),
  // Optional echo of the derived return value; must match when supplied.
  debitNoteAmount: moneySchema.optional(),
  notes: z.string().trim().max(1000).optional(),
  // Client-supplied de-duplication key. A retry with the same key returns the
  // original return instead of creating a second one.
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const purchaseReturnListQuerySchema = z
  .object({
    supplierId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    reason: returnReasonEnum.optional(),
  })
  .merge(paginationQuerySchema);

export const purchaseReturnParamsSchema = z.object({
  id: uuidSchema,
});

export const purchaseReturnableQuerySchema = z.object({
  supplierId: uuidSchema,
});
export const purchaseReturnableParamsSchema = z.object({
  purchaseOrderItemId: uuidSchema,
});
