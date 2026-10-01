import type { Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import {
  invoiceReceivingService,
  type InvoiceUploadInput,
} from "../../services/purchasing/invoice-receiving.service.js";
import { invoiceExtractionService } from "../../services/purchasing/invoice-extraction.service.js";
import {
  invoiceDocumentService,
  MAX_INVOICE_FILE_BYTES,
  type UploadedInvoiceFile,
} from "../../services/purchasing/invoice-document.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

/**
 * Multipart handler for the invoice document upload. Memory storage keeps the
 * file in RAM only for the duration of the request — nothing touches disk and
 * client-supplied filenames are never used as paths (no traversal risk).
 */
const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_INVOICE_FILE_BYTES,
    files: 1,
  },
});

/**
 * Wraps the multer middleware so its errors (413 limit, unexpected field, malformed
 * body) surface through the project's error envelope instead of resetting the
 * connection. Errors from multer are forwarded via next(); everything else passes
 * through untouched.
 */
function wrapMulter(handler: (req: Request, res: Response, next: (err?: unknown) => void) => void) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      handler(req, res, (err?: unknown) => {
        if (err) {
          try {
            mapMulterError(err);
          } catch (mapped) {
            next(mapped);
          }
          return;
        }
        next();
      });
    } catch (error) {
      try {
        mapMulterError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  };
}

/** Maps multer's own errors onto the project's AppError envelope. */
function mapMulterError(error: unknown): never {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      throw new AppError(
        413,
        ErrorCode.VALIDATION_ERROR,
        `Invoice document exceeds the ${Math.round(MAX_INVOICE_FILE_BYTES / (1024 * 1024))} MB size limit`,
      );
    }
    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      throw new AppError(
        422,
        ErrorCode.VALIDATION_ERROR,
        "Unexpected upload field; attach the document as `file`",
      );
    }
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, `Upload failed: ${error.code}`);
  }
  throw error as Error;
}

function readUpload(req: Request): UploadedInvoiceFile {
  if (!req.is("multipart/form-data")) {
    throw new AppError(
      415,
      ErrorCode.VALIDATION_ERROR,
      "Content-Type must be multipart/form-data with a `file` field",
    );
  }
  const anyReq = req as Request & {
    file?: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  };
  const file = anyReq.file;
  if (!file) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, "Missing `file` field");
  }
  return {
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    buffer: file.buffer,
  };
}

export const invoiceReceivingController = {
  /**
   * Extracts a normalized, user-reviewable invoice from an UPLOADED document
   * (PDF/JPEG/PNG/WEBP, multipart/form-data). Pure transformation: reads
   * nothing, writes nothing, creates no SupplierInvoice. PDFs are parsed from
   * their embedded text layer; images are validated and returned with a
   * warning that OCR review is required.
   */
  extractDocument: [
    invoiceUpload.single("file"),
    asyncHandler(async (req: Request, res: Response) => {
      const data = await invoiceDocumentService.extractFromFile(readUpload(req));
      sendSuccess(res, data);
    }),
  ].map((handler, index) => (index === 0 ? wrapMulter(handler) : handler)),

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
   * Confirms the receiving operation: creates a Goods Receipt, confirms
   * it (batches + stock movements + PO quantities) and creates the linked
   * Supplier Invoice — all inside one database transaction.
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
