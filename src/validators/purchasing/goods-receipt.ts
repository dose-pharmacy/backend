import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema } from "../inventory/common.js";

const grStatusEnum = z.enum(["MATCHED", "DISCREPANCY", "RESOLVED"]);

export const createGRItemSchema = z.object({
  purchaseOrderItemId: uuidSchema,
  locationId: uuidSchema,
  deliveredQty: quantitySchema,
  actualQty: quantitySchema,
  batchNumber: z.string().trim().max(100).optional(),
  manufacturingDate: z.coerce.date().optional(),
  expiryDate: z.coerce.date().optional(),
});

export const createGoodsReceiptSchema = z.object({
  receivedDate: z.coerce.date().optional(),
  discrepancyNote: z.string().trim().max(1000).optional(),
  items: z.array(createGRItemSchema).min(1, "At least one item is required"),
});

export const updateGRItemSchema = z.object({
  id: uuidSchema,
  deliveredQty: quantitySchema.optional(),
  actualQty: quantitySchema.optional(),
  batchNumber: z.string().trim().max(100).nullable().optional(),
  manufacturingDate: z.coerce.date().nullable().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
});

export const resolveGoodsReceiptSchema = z.object({
  discrepancyNote: z.string().trim().max(1000).optional(),
  items: z.array(updateGRItemSchema).optional(),
});

export const goodsReceiptListQuerySchema = z
  .object({
    purchaseOrderId: uuidSchema.optional(),
    status: grStatusEnum.optional(),
  })
  .merge(paginationQuerySchema);

export const goodsReceiptParamsSchema = z.object({
  id: uuidSchema,
});

export const grItemParamsSchema = z.object({
  id: uuidSchema,
});