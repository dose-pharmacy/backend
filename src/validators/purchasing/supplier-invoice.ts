import { z } from "zod";
import { paginationQuerySchema, uuidSchema, decimalNumber } from "../inventory/common.js";

const invoiceStatusEnum = z.enum(["OPEN", "PARTIALLY_PAID", "PAID"]);

const positiveMoneySchema = decimalNumber({
  minInclusive: 0.01,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be greater than zero and at most 9999999999.99 with at most 2 decimal places",
});

export const createSupplierInvoiceSchema = z.object({
  invoiceNumber: z.string().trim().min(1, "Invoice number is required").max(100),
  supplierId: uuidSchema,
  purchaseOrderId: uuidSchema.optional(),
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  invoiceAmount: positiveMoneySchema,
  paymentTerms: z.string().trim().max(500).optional(),
});

export const updateSupplierInvoiceSchema = z.object({
  dueDate: z.coerce.date().nullable().optional(),
  paymentTerms: z.string().trim().max(500).nullable().optional(),
});

export const recordPaymentSchema = z.object({
  amount: positiveMoneySchema,
  paymentDate: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const supplierInvoiceListQuerySchema = z
  .object({
    supplierId: uuidSchema.optional(),
    status: invoiceStatusEnum.optional(),
    search: z.string().trim().max(200).optional(),
  })
  .merge(paginationQuerySchema);

export const supplierInvoiceParamsSchema = z.object({
  id: uuidSchema,
});

export const supplierPaymentParamsSchema = z.object({
  id: uuidSchema,
});