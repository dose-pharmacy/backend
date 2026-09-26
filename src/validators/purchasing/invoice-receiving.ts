import { z } from "zod";
import { uuidSchema, quantitySchema, moneySchema } from "../inventory/common.js";

/**
 * A single extracted (and user-correctable) invoice line. Every field except
 * `quantity` is optional: the receiving flow tolerates missing OCR data and
 * surfaces it as a discrepancy instead of guessing.
 */
export const invoiceUploadItemSchema = z.object({
  // User-confirmed match against a PO item (overrides server-side matching).
  purchaseOrderItemId: uuidSchema.optional(),
  productCode: z.string().trim().max(100).optional(),
  productName: z.string().trim().max(300).optional(),
  // Document / invoice quantity for the line.
  quantity: quantitySchema,
  // Physically accepted quantity; defaults to `quantity` when omitted.
  acceptedQuantity: quantitySchema.optional(),
  unit: z.string().trim().max(50).optional(),
  unitPrice: moneySchema.optional(),
  batchNumber: z.string().trim().max(100).nullable().optional(),
  expiryDate: z.coerce.date().optional(),
  manufacturingDate: z.coerce.date().optional(),
  locationId: uuidSchema.optional(),
});

/**
 * Request body for both the invoice-upload preview and its confirmation. The
 * frontend sends the extracted invoice (optionally after the user corrected
 * values) plus the receiving location. The supplier is NEVER taken from the
 * body — it is always the selected PO's supplier.
 */
export const invoiceUploadSchema = z.object({
  locationId: uuidSchema,
  receivedDate: z.coerce.date().optional(),
  invoiceNumber: z.string().trim().min(1, "Invoice number is required").max(100),
  invoiceDate: z.coerce.date().optional(),
  grandTotal: moneySchema.optional(),
  // Informational only; the PO's supplier is authoritative.
  supplierName: z.string().trim().max(200).optional(),
  documentUrl: z.string().trim().max(2000).optional(),
  // Required when documented and accepted quantities differ.
  discrepancyNote: z.string().trim().max(1000).optional(),
  // Payment terms for the supplier invoice
  paymentTerms: z.enum(["CREDIT", "NO_CREDIT"]).optional(),
  dueDate: z.coerce.date().optional(),
  // Payment method for the supplier invoice
  paymentMethod: z.enum(["CASH", "CARD", "DIGITAL_TRANSFER"]).optional(),
  items: z.array(invoiceUploadItemSchema).min(1, "At least one invoice line is required"),
}).superRefine((value, ctx) => {
  if (value.paymentTerms === "CREDIT" && !value.dueDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dueDate"],
      message: "dueDate is required when paymentTerms is CREDIT",
    });
  }
  if (value.paymentTerms === "NO_CREDIT" && value.dueDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dueDate"],
      message: "dueDate must not be provided when paymentTerms is NO_CREDIT",
    });
  }
});

export const invoiceReceivingParamsSchema = z.object({
  id: uuidSchema,
});
