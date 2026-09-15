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
  batchId: uuidSchema.optional(),
  locationId: uuidSchema,
  reason: returnReasonEnum,
  quantity: quantitySchema,
  unitCost: positiveMoneySchema,
  debitNoteAmount: moneySchema.optional(),
  notes: z.string().trim().max(1000).optional(),
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