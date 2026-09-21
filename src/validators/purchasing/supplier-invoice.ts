import { z } from "zod";
import { paginationQuerySchema, uuidSchema, decimalNumber, moneySchema, quantitySchema } from "../inventory/common.js";

const invoiceStatusEnum = z.enum(["OPEN", "PARTIALLY_PAID", "PAID"]);

const positiveMoneySchema = decimalNumber({
  minInclusive: 0.01,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be greater than zero and at most 9999999999.99 with at most 2 decimal places",
});

export const invoiceItemSchema = z.object({
  purchaseOrderItemId: uuidSchema,
  // Quantity invoiced, in the PO item's ordered unit.
  quantity: quantitySchema,
  // Optional per-item unit-cost override; defaults to the PO item's unitCost.
  unitCost: positiveMoneySchema.optional(),
});

export const createSupplierInvoiceSchema = z
  .object({
    invoiceNumber: z.string().trim().min(1, "Invoice number is required").max(100),
    supplierId: uuidSchema,
    purchaseOrderId: uuidSchema.optional(),
    invoiceDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    // Value of received goods being billed. Required for non-PO invoices;
    // derived from the item allocations for PO-linked invoices (must match if
    // supplied).
    goodsAmount: moneySchema.optional(),
    taxAmount: moneySchema.optional(),
    additionalChargesAmount: moneySchema.optional(),
    discountAmount: moneySchema.optional(),
    paymentTerms: z.string().trim().max(500).optional(),
    // Goods allocation for PO-linked invoices. Required when purchaseOrderId
    // is present; prevents double-invoicing of received goods.
    items: z.array(invoiceItemSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.purchaseOrderId && (!value.items || value.items.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "A PO-linked invoice must allocate its goods to at least one purchase order item",
      });
    }
    if (!value.purchaseOrderId && value.items && value.items.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Invoice items can only be supplied for a PO-linked invoice",
      });
    }
    if (value.discountAmount !== undefined && value.discountAmount > 0 && !value.goodsAmount) {
      // Discount without goods is allowed only when it cannot invert the
      // total; the service recomputes the total and rejects negatives.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["goodsAmount"],
        message: "goodsAmount is required when a discount is applied",
      });
    }
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