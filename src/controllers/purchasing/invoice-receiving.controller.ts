import type { Request, Response } from "express";
import { invoiceReceivingService, type InvoiceUploadInput } from "../../services/purchasing/invoice-receiving.service.js";
import { invoiceExtractionService } from "../../services/purchasing/invoice-extraction.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const invoiceReceivingController = {
  /**
   * Normalizes a raw supplier invoice document (text, pre-split lines from an
   * OCR adapter, or an already-parsed draft) into the review payload used by
   * the upload preview. Pure transformation: reads nothing, writes nothing.
   * Extracted values are proposals for user review — the confirm endpoint
   * revalidates everything against the live database.
   */
  extract: asyncHandler(async (req: Request, res: Response) => {
    const data = await invoiceExtractionService.extract(req.body);
    sendSuccess(res, data);
  }),

  /**
   * Read-only preview of an invoice-assisted receiving operation. Extracts
   * nothing and mutates nothing — it matches the invoice against the selected
   * PO and returns the receiving draft plus any discrepancies.
   */
  preview: asyncHandler(async (req: Request, res: Response) => {
    const data = await invoiceReceivingService.preview(
      req.params.id as string,
      req.body as InvoiceUploadInput,
    );
    sendSuccess(res, data);
  }),

  /**
   * Confirms the receiving operation: atoms, creates a Goods Receipt, confirms
   * it (batches + stock movements + PO quantities) and creates the linked
   * Supplier Invoice.
   */
  confirm: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await invoiceReceivingService.confirm(
      req.params.id as string,
      req.body as InvoiceUploadInput,
      actor,
    );
    sendSuccess(res, data, { status: 201 });
  }),
};
