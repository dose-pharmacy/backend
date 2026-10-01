import { z } from "zod";

/**
 * Request body for `POST /purchase-orders/:id/invoice-upload/extract`.
 *
 * Accepts raw document text, pre-split document lines (e.g. from an external
 * OCR adapter), or an already-parsed draft. Extraction output is a review-only
 * proposal: it is never persisted and never mutates anything.
 */
export const invoiceExtractionSchema = z
  .object({
    text: z.string().max(200_000).optional(),
    lines: z
      .array(
        z.union([
          z.string().max(500),
          z.object({
            productCode: z.string().trim().max(100).nullish(),
            productName: z.string().trim().max(300).nullish(),
            quantity: z.number().nonnegative().nullish(),
            unit: z.string().trim().max(50).nullish(),
            unitPrice: z.number().nonnegative().nullish(),
            lineTotal: z.number().nullish(),
            batchNumber: z.string().trim().max(100).nullish(),
            expiryDate: z.string().trim().max(40).nullish(),
          }),
        ]),
      )
      .max(5_000)
      .optional(),
    document: z
      .object({
        supplierName: z.string().trim().max(200).nullish(),
        supplierTin: z.string().trim().max(30).nullish(),
        invoiceNumber: z.string().trim().max(100).nullish(),
        invoiceDate: z.string().trim().max(40).nullish(),
        fsNumber: z.string().trim().max(30).nullish(),
        items: z
          .array(
            z.object({
              productCode: z.string().trim().max(100).nullish(),
              productName: z.string().trim().max(300).nullish(),
              quantity: z.number().nonnegative().nullish(),
              unit: z.string().trim().max(50).nullish(),
              unitPrice: z.number().nonnegative().nullish(),
              lineTotal: z.number().nullish(),
              batchNumber: z.string().trim().max(100).nullish(),
              expiryDate: z.string().trim().max(40).nullish(),
            }),
          )
          .max(5_000)
          .optional(),
        subtotal: z.number().nullish(),
        discount: z.number().nullish(),
        tax: z.number().nullish(),
        fees: z.number().nullish(),
        grandTotal: z.number().nullish(),
        paymentTerms: z.enum(["CREDIT", "NO_CREDIT"]).nullish(),
      })
      .optional(),
  })
  .refine((v) => v.text !== undefined || v.lines !== undefined || v.document !== undefined, {
    message: "Provide one of: text, lines or document",
  });

export type InvoiceExtractionInput = z.infer<typeof invoiceExtractionSchema>;
