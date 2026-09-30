import { z } from "zod";
import {
  paginationQuerySchema,
  quantitySchema,
  uuidSchema,
} from "../inventory/common.js";
import { paymentMethodSchema } from "./sale.js";

export const saleReturnParamsSchema = z.object({
  id: uuidSchema,
});

/**
 * One returned sale line.
 *
 * `saleItemId` identifies the EXACT original sold line (never a productId):
 * the same product can appear in several sales at different prices and
 * discounts, so a return must always point at one specific sold line.
 *
 * `quantity` is expressed in the unit the customer received the item in — the
 * same unit the original sale line used. It is normalized to base units
 * server-side using the SALE-TIME conversion factor snapshot, so a later
 * change to the product's unit configuration cannot alter past returns.
 *
 * `restock` decides whether the returned units go back into sellable
 * inventory. When false the return and its immediate refund are still
 * recorded, but no stock is restored.
 *
 * No refund amount is accepted from the client: the backend always derives
 * the refund from the original sale's financial values.
 */
export const saleReturnItemInputSchema = z.object({
  saleItemId: uuidSchema,
  quantity: quantitySchema,
  restock: z.boolean().default(true),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Creates a customer return against a COMPLETED sale.
 *
 * The location is NOT accepted from the client: stock is always restored to
 * the original sale's location.
 */
export const createSaleReturnSchema = z.object({
  items: z
    .array(saleReturnItemInputSchema)
    .min(1, "At least one item is required")
    .max(200, "A return cannot contain more than 200 items"),
  refundMethod: paymentMethodSchema,
  refundReference: z.string().trim().max(200).optional(),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(500).optional(),
  /**
   * Optional client-supplied de-duplication key. Re-sending the same key
   * returns the original return instead of creating a second refund and
   * stock movement.
   */
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const saleReturnListQuerySchema = z
  .object({
    saleId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    refundMethod: paymentMethodSchema.optional(),
    restock: z.enum(["true", "false"]).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);