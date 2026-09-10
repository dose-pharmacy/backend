import { z } from "zod";
import {
  moneySchema,
  paginationQuerySchema,
  quantitySchema,
  uuidSchema,
} from "../inventory/common.js";

export const paymentMethodSchema = z.enum(["CASH", "CARD", "DIGITAL_TRANSFER"]);
export const discountTypeSchema = z.enum(["PERCENTAGE", "FIXED_AMOUNT"]);

/**
 * Discount on one sale item or on the whole bill.
 *  - PERCENTAGE: value in percent, 0 < value <= 100
 *  - FIXED_AMOUNT: value is a money amount (0 <= value), capped at the
 *    pre-discount total so it can never create a negative line/bill total.
 */
const discountSchema = z
  .object({
    type: discountTypeSchema,
    value: moneySchema,
  })
  .superRefine((value, ctx) => {
    if (value.type === "PERCENTAGE" && value.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "A percentage discount must be at most 100",
      });
    }
  });

export const salePaymentSchema = z.object({
  method: paymentMethodSchema,
  amount: moneySchema,
  reference: z.string().trim().max(200).optional(),
});

/**
 * One POS sale line. `quantity` is the cashier-entered quantity in `unitId`;
 * `baseQuantity` is server-calculated from the ProductUnit conversion factor
 * and is never accepted from the client. `actualUnitPrice` (price override)
 * is optional — when omitted the configured ProductUnit.sellPrice is used.
 */
export const saleItemSchema = z.object({
  productId: uuidSchema,
  unitId: uuidSchema,
  quantity: quantitySchema,
  actualUnitPrice: moneySchema.optional(),
  discount: discountSchema.optional(),
});

/**
 * Completes a sale atomically: validates products/units/stock, calculates
 * prices and discounts, allocates batches with FEFO, creates the sale +
 * items + payments + batch allocations and moves stock (SALE/OUT) — all in
 * one transaction. Every item needs a quantity > 0; every sale needs at
 * least one item and one payment (total payments must cover totalAmount).
 */
export const createSaleSchema = z
  .object({
    locationId: uuidSchema,
    items: z.array(saleItemSchema).min(1, "At least one item is required"),
    payments: z.array(salePaymentSchema).min(1, "At least one payment is required"),
    billDiscount: discountSchema.optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    // A payment with a zero amount is meaningless.
    value.payments.forEach((payment, index) => {
      if (payment.amount === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payments", index, "amount"],
          message: "Payment amount must be greater than zero",
        });
      }
    });
  });

export const saleListQuerySchema = z
  .object({
    status: z.enum(["DRAFT", "COMPLETED", "CANCELLED"]).optional(),
    locationId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    search: z.string().trim().max(64).optional(),
  })
  .merge(paginationQuerySchema);

export const saleParamsSchema = z.object({
  id: uuidSchema,
});

// Optional body: a body-less POST is valid.
export const cancelSaleSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .optional();