import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema, decimalNumber } from "../inventory/common.js";

const poStatusEnum = z.enum(["AWAITING_DELIVERY", "RECEIVED", "CLOSED", "CANCELLED"]);
const poPaymentStatusEnum = z.enum(["NOT_INVOICED", "UNPAID", "PARTIALLY_PAID", "PAID", "ALL"]);

const positiveMoneySchema = decimalNumber({
  minInclusive: 0.01,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be greater than zero and at most 9999999999.99 with at most 2 decimal places",
});

export const createPOItemSchema = z.object({
  productId: uuidSchema,
  // Quantity is expressed in this unit and converted to base units by the
  // service. Omit to default to the product's base unit.
  unitId: uuidSchema.optional(),
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

// Ordering directly from a requirement: the product is derived from the requirement
// line, so the client only supplies the line, quantity and unit cost.
export const createPOFromRequirementItemSchema = z.object({
  requirementLineId: uuidSchema,
  quantityOrdered: quantitySchema,
  unitCost: positiveMoneySchema,
});

export const createPurchaseOrderFromRequirementSchema = z.object({
  supplierId: uuidSchema,
  expectedDeliveryDate: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z.array(createPOFromRequirementItemSchema).min(1, "At least one item is required"),
});

export const updatePurchaseOrderSchema = z.object({
  expectedDeliveryDate: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const updatePurchaseOrderItemSchema = z
  .object({
    quantityOrdered: quantitySchema.optional(),
    unitCost: positiveMoneySchema.optional(),
  })
  .refine((value) => value.quantityOrdered !== undefined || value.unitCost !== undefined, {
    message: "At least one of quantityOrdered or unitCost is required",
  });

export const purchaseOrderListQuerySchema = z
  .object({
    supplierId: uuidSchema.optional(),
    status: poStatusEnum.optional(),
    paymentStatus: poPaymentStatusEnum.optional(),
    search: z.string().trim().max(200).optional(),
  })
  .merge(paginationQuerySchema);

export const purchaseOrderParamsSchema = z.object({
  id: uuidSchema,
});

export const purchaseOrderItemParamsSchema = z.object({
  itemId: uuidSchema,
});

export const poStatusActionSchema = z.object({
  // No body needed for cancel/close actions.
});

export const acceptShortageSchema = z
  .object({
    // Optional: defaults to the full remaining quantity (ordered - received - short).
    quantityShort: quantitySchema.optional(),
    shortReason: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => value.quantityShort !== undefined || value.shortReason !== undefined, {
    message: "At least one of quantityShort or shortReason is required",
  });
