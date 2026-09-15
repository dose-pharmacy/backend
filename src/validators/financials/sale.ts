import { z } from "zod";
import { paginationQuerySchema, uuidSchema, quantitySchema, moneySchema, decimalNumber } from "../inventory/common.js";

const saleStatusEnum = z.enum(["COMPLETED", "CANCELLED"]);
const paymentMethodEnum = z.enum(["CASH", "CARD", "DIGITAL_TRANSFER"]);

const positiveMoneySchema = decimalNumber({
  minInclusive: 0.01,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be greater than zero and at most 9999999999.99 with at most 2 decimal places",
});

export const createSaleLineSchema = z.object({
  productId: uuidSchema,
  unitSold: z.string().trim().min(1, "Unit is required").max(50),
  quantity: quantitySchema,
  quantityBaseUnits: z.number().positive("Quantity in base units must be greater than zero"),
  unitPrice: positiveMoneySchema,
  itemDiscountAmount: moneySchema.optional(),
});

export const createSaleSchema = z.object({
  locationId: uuidSchema,
  lines: z.array(createSaleLineSchema).min(1, "At least one line is required"),
  billDiscountAmount: moneySchema.optional(),
  payments: z.array(z.object({
    method: paymentMethodEnum,
    amount: positiveMoneySchema,
reference: z.string().trim().max(100).optional(),
  })).min(1, "At least one payment is required"),
});

export const updateSaleSchema = z.object({
  voidReason: z.string().trim().max(500).optional(),
  status: saleStatusEnum.optional(),
});

export const createPaymentSchema = z.object({
  saleId: uuidSchema,
  method: paymentMethodEnum,
  amount: positiveMoneySchema,
  referenceNumber: z.string().trim().max(100).optional(),
});

export const saleListQuerySchema = z
  .object({
    status: z.enum(["COMPLETED", "CANCELLED"]).optional(),
    locationId: uuidSchema.optional(),
    cashierId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

export const saleParamsSchema = z.object({
  id: uuidSchema,
});

export const voidSaleSchema = z.object({
  voidReason: z.string().trim().min(1, "Void reason is required").max(500),
});

export const saleDetailQuerySchema = z
  .object({
    saleId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    cashierId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);