import { z } from "zod";
import { paginationQuerySchema, uuidSchema } from "../inventory/common.js";

export const creditSaleStatusSchema = z.enum(["OUTSTANDING", "PARTIALLY_PAID", "PAID", "ALL"]);

export const creditSalesListQuerySchema = z
  .object({
    customerName: z.string().trim().max(200).optional(),
    customerPhone: z.string().trim().max(50).optional(),
    saleNumber: z.string().trim().max(64).optional(),
    status: creditSaleStatusSchema.optional(),
    locationId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

export const creditSaleParamsSchema = z.object({
  id: uuidSchema,
});

export type CreditSaleStatus = z.infer<typeof creditSaleStatusSchema>;