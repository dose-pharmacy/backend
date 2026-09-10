import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema, decimalNumber } from "../inventory/common.js";

const poStatusEnum = z.enum(["REGISTERED", "AWAITING_DELIVERY", "RECEIVED", "CLOSED", "CANCELLED"]);

const positiveMoneySchema = decimalNumber({
  minInclusive: 0.01,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be greater than zero and at most 9999999999.99 with at most 2 decimal places",
});

export const createPOItemSchema = z.object({
  productId: uuidSchema,
  quantityOrdered: quantitySchema,
  unitCost: positiveMoneySchema,
  requirementLineId: uuidSchema.optional(),
});

export const createPurchaseOrderSchema = z.object({
  supplierId: uuidSchema,
  expectedDeliveryDate: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z.array(createPOItemSchema).min(1, "At least one item is required"),
});

export const updatePurchaseOrderSchema = z.object({
  expectedDeliveryDate: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const purchaseOrderListQuerySchema = z
  .object({
    supplierId: uuidSchema.optional(),
    status: poStatusEnum.optional(),
    search: z.string().trim().max(200).optional(),
  })
  .merge(paginationQuerySchema);

export const purchaseOrderParamsSchema = z.object({
  id: uuidSchema,
});

export const poStatusActionSchema = z.object({
  // No body needed for cancel/mark-delivered/close actions
});