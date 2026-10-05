import { PDFParse } from "pdf-parse";
import { randomUUID } from "node:crypto";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import {
  invoiceExtractionService,
  type ExtractedInvoice,
} from "./invoice-extraction.service.js";
import { invoiceOcrService } from "./invoice-ocr.service.js";
import { logger } from "../../config/logger.js";
import {
  extractDeviceTradingCreditSales,
  isDeviceTradingCreditSalesTemplate,
} from "./device-trading-credit-sales.template.js";

// /**
//  * ============================================================================
//  * Invoice document upload extraction (multipart file -> normalized JSON)
//  * ============================================================================
//  *
//  * Accepts an ACTUAL supplier invoice document (PDF/JPEG/PNG/WEBP), validates it
//  * safely, extracts what it can, and hands the result to the existing
//  * invoice-extraction normalizer. The output stays a USER-REVIEWABLE PROPOSAL:
//  * nothing is persisted, no SupplierInvoice is created, and the confirm-time
//  * revalidation in invoice-receiving.service.ts is unchanged.
//  *
//  * Extraction strategy (deliberately no external OCR/AI dependency):
//  *  - PDF:      pdf-parse extracts embedded text; the existing text heuristics
//  *              parse header/items/totals from it.
//  *  - Images:   JPEG/PNG/WEBP have no embedded text layer. The file is
//  *              validated and echoed back as metadata with a warning that a
//  *              text layer is unavailable, so the user reviews/enters values —
//  *              the same contract as an OCR adapter running out-of-process.
//  *
//  * Security:
//  *  - Magic-byte sniffing (never trust the client MIME/filename).
//  *  - Hard size cap (checked before AND after multer's limit).
//  *  - Text layer treated as untrusted input, same as any request body.
//  *  - Nothing is written to disk: files live only in memory for the request.
//  */

// /** 10 MB — comfortably above a phone photo of an invoice, small enough to be safe. */
// export const MAX_INVOICE_FILE_BYTES = 10 * 1024 * 1024;

// type SupportedKind = "pdf" | "jpeg" | "png" | "webp";

// const SUPPORTED: Record<SupportedKind, { mime: string[]; extensions: string[]; label: string }> = {
//   pdf: { mime: ["application/pdf"], extensions: [".pdf"], label: "PDF" },
//   jpeg: { mime: ["image/jpeg", "image/jpg"], extensions: [".jpg", ".jpeg"], label: "JPEG" },
//   png: { mime: ["image/png"], extensions: [".png"], label: "PNG" },
//   webp: { mime: ["image/webp"], extensions: [".webp"], label: "WEBP" },
// };

// function magicKind(bytes: Uint8Array): SupportedKind | null {
//   // %PDF-
//   if (
//     bytes.length >= 5 &&
//     bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
//   ) {
//     return "pdf";
//   }
//   // FF D8 FF (JPEG SOI + first marker)
//   if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
//     return "jpeg";
//   }
//   // 89 50 4E 47 0D 0A 1A 0A (PNG signature)
//   if (
//     bytes.length >= 8 &&
//     bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
//     bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
//   ) {
//     return "png";
//   }
//   // "RIFF" .... "WEBP"
//   if (
//     bytes.length >= 12 &&
//     bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
//     bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
//   ) {
//     return "webp";
//   }
//   return null;
// }

// function extensionKind(filename: string | undefined): SupportedKind | null {
//   if (!filename) return null;
//   const lower = filename.toLowerCase();
//   for (const [kind, spec] of Object.entries(SUPPORTED)) {
//     if (spec.extensions.some((ext) => lower.endsWith(ext))) {
//       return kind as SupportedKind;
//     }
//   }
//   return null;
// }

// export type UploadedInvoiceFile = {
//   /** Original client filename (informational, never used as a storage path). */
//   originalName: string;
//   mimeType: string;
//   size: number;
//   buffer: Buffer;
// };

// /**
//  * Validates an uploaded document. Enforced in order:
//  *   1. non-empty
//  *   2. size cap
//  *   3. magic bytes match a supported format
//  *   4. declared MIME type / extension are not for a DIFFERENT format
//  * (an unknown declared type is tolerated; a contradictory one is not).
//  */
// export function validateInvoiceFile(file: UploadedInvoiceFile): SupportedKind {
//   if (!file.buffer || file.buffer.length === 0) {
//     throw new AppError(422, ErrorCode.VALIDATION_ERROR, "Uploaded file is empty");
//   }
//   if (file.size > MAX_INVOICE_FILE_BYTES || file.buffer.length > MAX_INVOICE_FILE_BYTES) {
//     throw new AppError(
//       413,
//       ErrorCode.VALIDATION_ERROR,
//       `Invoice document exceeds the ${Math.round(MAX_INVOICE_FILE_BYTES / (1024 * 1024))} MB size limit`,
//     );
//   }

//   const kind = magicKind(file.buffer.subarray(0, 16));
//   if (!kind) {
//     throw new AppError(
//       415,
//       ErrorCode.VALIDATION_ERROR,
//       "Unsupported invoice document: expected PDF, JPEG, PNG or WEBP content",
//     );
//   }

//   const declared = file.mimeType.toLowerCase();
//   const declaredOk =
//     SUPPORTED[kind].mime.includes(declared) || declared === "" || declared === "application/octet-stream";
//   const extOk =
//     extensionKind(file.originalName) === null || extensionKind(file.originalName) === kind;
//   if (!declaredOk || !extOk) {
//     throw new AppError(
//       415,
//       ErrorCode.VALIDATION_ERROR,
//       "Declared file type does not match the actual document content",
//     );
//   }

//   return kind;
// }

// async function extractPdfText(buffer: Buffer): Promise<string> {
//   const parser = new PDFParse({ data: new Uint8Array(buffer) });
//   try {
//     const result = await parser.getText();
//     return result.text ?? "";
//   } finally {
//     await parser.destroy();
//   }
// }

// export type InvoiceDocumentExtraction = ExtractedInvoice & {
//   document: {
//     /** Detected content kind (from magic bytes, not the client). */
//     kind: SupportedKind;
//     fileName: string | null;
//     sizeBytes: number;
//     /** True when text was embedded in the document (PDF) and parsed. */
//     textExtracted: boolean;
//   };
// };

// export const invoiceDocumentService = {
//   /**
//    * Full pipeline for an uploaded invoice document:
//    * validate -> extract text (PDF) or flag image -> normalize via the existing
//    * extraction service. Pure transformation: no database, no persistence.
//    */
//   async extractFromFile(file: UploadedInvoiceFile): Promise<InvoiceDocumentExtraction> {
//     const kind = validateInvoiceFile(file);

//     let text = "";
//     const warnings: string[] = [];
//     let textExtracted = false;

//     if (kind === "pdf") {
//       try {
//         text = await extractPdfText(file.buffer);
//         textExtracted = text.trim().length > 0;
//         if (!textExtracted) {
//           warnings.push(
//             "The PDF contains no extractable text (likely a scanned image); enter the invoice details manually or use an OCR adapter",
//           );
//         }
//       } catch {
//         throw new AppError(
//           422,
//           ErrorCode.VALIDATION_ERROR,
//           "The PDF document could not be read (corrupted or password-protected)",
//         );
//       }
//     } else {
//       warnings.push(
//         `${SUPPORTED[kind].label} images carry no machine-readable text; the file was validated but OCR must supply the content for review`,
//       );
//     }

//     // Existing normalizer parses the untrusted text with the same heuristics
//     // used for pasted text/lines — OCR output is just untrusted input.
//     const base =
//       text.trim().length > 0
//         ? await invoiceExtractionService.extract({ text })
//         : await invoiceExtractionService.extract({ lines: [] });

//     return {
//       ...base,
//       source: "text",
//       warnings: [...warnings, ...base.warnings],
//       document: {
//         kind,
//         fileName: file.originalName || null,
//         sizeBytes: file.buffer.length,
//         textExtracted,
//       },
//     };
//   },
// };

// import { PDFParse } from "pdf-parse";
// import { AppError } from "../../errors/app-error.js";
// import { ErrorCode } from "../../errors/error-codes.js";
// import {
//   invoiceExtractionService,
//   type ExtractedInvoice,
// } from "./invoice-extraction.service.js";


/**
 * ============================================================================
 * Invoice document upload extraction
 * ============================================================================
 *
 * Accepts an actual supplier invoice document:
 *   - PDF
 *   - JPEG
 *   - PNG
 *   - WEBP
 *
 * Extraction strategy:
 *
 *   PDF
 *     -> extract embedded text with pdf-parse
 *     -> existing invoice normalizer
 *
 *   Image
 *     -> local image preprocessing + Tesseract OCR
 *     -> existing invoice normalizer
 *
 * No external AI/OCR API is used.
 *
 * The extraction result is ALWAYS a USER-REVIEWABLE PROPOSAL.
 *
 * Nothing is persisted here:
 *   - no SupplierInvoice
 *   - no stock changes
 *   - no payment
 *   - no database writes
 *
 * Confirmation/revalidation remains the responsibility of
 * invoice-receiving.service.ts.
 *
 * Security:
 *   - Magic-byte sniffing; never trust client MIME/extension alone.
 *   - Hard size cap.
 *   - Text/OCR output is treated as untrusted input.
 *   - Files remain in memory for the request.
 */

/**
 * 10 MB maximum invoice file size.
 */
export const MAX_INVOICE_FILE_BYTES = 10 * 1024 * 1024;

type SupportedKind = "pdf" | "jpeg" | "png" | "webp";

const SUPPORTED: Record<
  SupportedKind,
  {
    mime: string[];
    extensions: string[];
    label: string;
  }
> = {
  pdf: {
    mime: ["application/pdf"],
    extensions: [".pdf"],
    label: "PDF",
  },

  jpeg: {
    mime: ["image/jpeg", "image/jpg"],
    extensions: [".jpg", ".jpeg"],
    label: "JPEG",
  },

  png: {
    mime: ["image/png"],
    extensions: [".png"],
    label: "PNG",
  },

  webp: {
    mime: ["image/webp"],
    extensions: [".webp"],
    label: "WEBP",
  },
};

/**
 * ============================================================================
 * File type detection
 * ============================================================================
 */

/**
 * Detect the actual file type from its magic bytes.
 *
 * Never rely only on:
 *   - file.originalname
 *   - file.mimetype
 *
 * because both can be controlled by the client.
 */
function magicKind(bytes: Uint8Array): SupportedKind | null {
  /**
   * PDF
   *
   * %PDF-
   */
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "pdf";
  }

  /**
   * JPEG
   *
   * FF D8 FF
   */
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }

  /**
   * PNG
   *
   * 89 50 4E 47 0D 0A 1A 0A
   */
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  /**
   * WEBP
   *
   * RIFF....WEBP
   */
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }

  return null;
}

/**
 * Detect file type from the original filename extension.
 *
 * This is only used as a consistency check.
 * The actual type comes from magic bytes.
 */
function extensionKind(
  filename: string | undefined,
): SupportedKind | null {
  if (!filename) {
    return null;
  }

  const lower = filename.toLowerCase();

  for (const [kind, spec] of Object.entries(SUPPORTED)) {
    if (
      spec.extensions.some((extension) =>
        lower.endsWith(extension),
      )
    ) {
      return kind as SupportedKind;
    }
  }

  return null;
}

/**
 * ============================================================================
 * Uploaded file contract
 * ============================================================================
 */

export type UploadedInvoiceFile = {
  /**
   * Original client filename.
   *
   * Informational only.
   * Never use it as a storage path.
   */
  originalName: string;

  /**
   * Client-declared MIME type.
   *
   * Never trust this by itself.
   */
  mimeType: string;

  /**
   * Size reported by the upload middleware.
   */
  size: number;

  /**
   * Actual file contents.
   */
  buffer: Buffer;
};

/**
 * ============================================================================
 * File validation
 * ============================================================================
 */

/**
 * Validate an uploaded invoice document.
 *
 * Validation order:
 *
 * 1. File exists / isn't empty
 * 2. File size is within limit
 * 3. Magic bytes identify a supported format
 * 4. Declared MIME type isn't contradictory
 * 5. Extension isn't contradictory
 *
 * Returns the detected content type.
 */
export function validateInvoiceFile(
  file: UploadedInvoiceFile,
): SupportedKind {
  /**
   * 1. Empty file
   */
  if (!file.buffer || file.buffer.length === 0) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      "Uploaded file is empty",
    );
  }

  /**
   * 2. File size
   *
   * Check both:
   *   - middleware-reported size
   *   - actual buffer length
   *
   * This protects against inconsistencies between the upload layer
   * and the actual received buffer.
   */
  if (
    file.size > MAX_INVOICE_FILE_BYTES ||
    file.buffer.length > MAX_INVOICE_FILE_BYTES
  ) {
    throw new AppError(
      413,
      ErrorCode.VALIDATION_ERROR,
      `Invoice document exceeds the ${Math.round(
        MAX_INVOICE_FILE_BYTES / (1024 * 1024),
      )} MB size limit`,
    );
  }

  /**
   * 3. Detect actual format from magic bytes.
   */
  const kind = magicKind(file.buffer.subarray(0, 16));

  if (!kind) {
    throw new AppError(
      415,
      ErrorCode.VALIDATION_ERROR,
      "Unsupported invoice document: expected PDF, JPEG, PNG or WEBP content",
    );
  }

  /**
   * 4. Validate declared MIME type.
   *
   * Empty / octet-stream declarations are tolerated because some
   * clients and proxies don't provide a useful MIME type.
   */
  const declared = (file.mimeType || "").toLowerCase();

  const declaredOk =
    SUPPORTED[kind].mime.includes(declared) ||
    declared === "" ||
    declared === "application/octet-stream";

  /**
   * 5. Validate extension.
   *
   * Unknown extension is tolerated because some clients may not provide
   * a conventional filename.
   *
   * But a known contradictory extension is rejected.
   */
  const detectedExtensionKind = extensionKind(
    file.originalName,
  );

  const extOk =
    detectedExtensionKind === null ||
    detectedExtensionKind === kind;

  if (!declaredOk || !extOk) {
    throw new AppError(
      415,
      ErrorCode.VALIDATION_ERROR,
      "Declared file type does not match the actual document content",
    );
  }

  return kind;
}

/**
 * ============================================================================
 * PDF extraction
 * ============================================================================
 */

/**
 * Extract embedded text from a PDF.
 *
 * This does NOT perform OCR.
 *
 * If the PDF is actually a scanned document, pdf-parse will normally return
 * little or no text. In that case the caller can warn the user that OCR is
 * required.
 */
async function extractPdfText(
  buffer: Buffer,
): Promise<string> {
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
  });

  try {
    const result = await parser.getText();

    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

/**
 * ============================================================================
 * Output contract
 * ============================================================================
 */

export type InvoiceDocumentExtraction = ExtractedInvoice & {
  document: {
    /**
     * Detected file type from magic bytes.
     */
    kind: SupportedKind;

    /**
     * Original filename.
     */
    fileName: string | null;

    /**
     * Actual received buffer size.
     */
    sizeBytes: number;

    /**
     * Whether useful text was extracted.
     *
     * true for:
     *   - PDF with embedded text
     *   - image successfully processed by OCR
     */
    textExtracted: boolean;

    /**
     * How the text was obtained.
     */
    extractionMethod:
      | "embedded-text"
      | "ocr"
      | "none";

    /**
     * Average OCR confidence.
     *
     * null for PDFs / when OCR wasn't used.
     */
    ocrConfidence: number | null;
  };
};

/**
 * ============================================================================
 * Invoice document service
 * ============================================================================
 */

export const invoiceDocumentService = {
  /**
   * Full invoice document extraction pipeline:
   *
   *   validate
   *      ↓
   *   detect format
   *      ↓
   *   ┌─────────────────────┐
   *   │ PDF                 │
   *   │ embedded text       │
   *   └─────────────────────┘
   *             OR
   *   ┌─────────────────────┐
   *   │ JPEG/PNG/WEBP       │
   *   │ local OCR            │
   *   └─────────────────────┘
   *      ↓
   *   normalized text
   *      ↓
   *   existing invoiceExtractionService
   *      ↓
   *   reviewable JSON
   *
   * Pure transformation:
   *   - no database writes
   *   - no SupplierInvoice creation
   *   - no stock mutation
   *   - no payment mutation
   */
  async extractFromFile(
    file: UploadedInvoiceFile,
  ): Promise<InvoiceDocumentExtraction> {
    const traceId = randomUUID();
    const startedAt = Date.now();
    logger.info({ traceId, stage: "document.extract.start", fileName: file.originalName, fileBytes: file.buffer.length, mimeType: file.mimeType }, "Invoice document extraction started");
    /**
     * ------------------------------------------------------------
     * STEP 1 — Validate file
     * ------------------------------------------------------------
     */
    const kind = validateInvoiceFile(file);
    logger.info({ traceId, stage: "document.validate.complete", kind }, "Invoice document validation completed");

    /**
     * ------------------------------------------------------------
     * STEP 2 — Prepare extraction state
     * ------------------------------------------------------------
     */
    let text = "";

    const warnings: string[] = [];

    let textExtracted = false;

    let extractionMethod:
      | "embedded-text"
      | "ocr"
      | "none" = "none";

    let ocrConfidence: number | null = null;
    let ocrPage: { width: number; height: number } | undefined;
    let ocrWords = [] as Awaited<ReturnType<typeof invoiceOcrService.extract>>["words"];

    /**
     * ------------------------------------------------------------
     * STEP 3 — PDF
     * ------------------------------------------------------------
     *
     * First try the embedded text layer.
     *
     * This is cheaper and generally more accurate than OCR when the
     * PDF already contains actual text.
     */
    if (kind === "pdf") {
      try {
        text = await extractPdfText(file.buffer);

        textExtracted = text.trim().length > 0;

        if (textExtracted) {
          extractionMethod = "embedded-text";
        } else {
          warnings.push(
            "The PDF contains no extractable text and may be a scanned document. OCR is required to extract its contents.",
          );
        }
      } catch {
        throw new AppError(
          422,
          ErrorCode.VALIDATION_ERROR,
          "The PDF document could not be read (corrupted or password-protected)",
        );
      }
    }

    /**
     * ------------------------------------------------------------
     * STEP 4 — Images
     * ------------------------------------------------------------
     *
     * JPEG / PNG / WEBP:
     *
     *   image
     *      ↓
     *   local OCR service
     *      ↓
     *   text
     *
     * No external AI/OCR API is involved.
     */
    else {
      try {
        const ocrResult =
          await invoiceOcrService.extract(file.buffer, traceId);

        text = ocrResult.text ?? "";
        ocrWords = ocrResult.words ?? [];
        if (ocrResult.width && ocrResult.height) {
          ocrPage = { width: ocrResult.width, height: ocrResult.height };
        }

        textExtracted = text.trim().length > 0;

        extractionMethod = "ocr";

        ocrConfidence = ocrResult.confidence;
        logger.info({ traceId, stage: "document.ocr.complete", textExtracted, words: ocrWords.length, confidence: ocrConfidence }, "Invoice document OCR stage completed");

        /**
         * OCR returned nothing.
         */
        if (!textExtracted) {
          warnings.push(
            "OCR completed but no readable text was detected in the invoice image.",
          );
        }

        /**
         * Low OCR confidence.
         *
         * Don't reject the document.
         * The result is still useful as a reviewable proposal.
         */
        if (
          ocrConfidence !== null &&
          ocrConfidence < 40
        ) {
          warnings.push(
            `OCR confidence is low (${ocrConfidence.toFixed(
              1,
            )}%). Please carefully review the extracted invoice values.`,
          );
        }
      } catch (error) {
        /**
         * Preserve our own AppError.
         */
        if (error instanceof AppError) {
          throw error;
        }

        throw new AppError(
          422,
          ErrorCode.VALIDATION_ERROR,
          "The invoice image could not be processed with OCR",
        );
      }
    }

    /**
     * ------------------------------------------------------------
     * STEP 5 — Normalize extracted text
     * ------------------------------------------------------------
     *
     * IMPORTANT:
     *
     * OCR output is treated exactly like pasted text.
     *
     * It is untrusted input.
     *
     * The existing invoiceExtractionService remains responsible for
     * parsing fields/items/totals.
     */
    const templateDetected = extractionMethod === "ocr" && isDeviceTradingCreditSalesTemplate(ocrWords);
    logger.info({ traceId, stage: "document.template.detected", templateDetected, words: ocrWords.length }, "Invoice template detection completed");
    let base: ExtractedInvoice;
    if (templateDetected) {
      try {
        base = extractDeviceTradingCreditSales(ocrWords, ocrConfidence, ocrPage, traceId);
        logger.info({ traceId, stage: "document.template.complete", items: base.items.length, invoiceNumber: base.invoiceNumber, warnings: base.warnings.length }, "Invoice template extraction completed");
      } catch {
        base = text.trim().length > 0
          ? await invoiceExtractionService.extract({ text })
          : await invoiceExtractionService.extract({ lines: [] });
        warnings.push("Invoice layout was not recognized; extracted values require manual review.");
      }
    } else {
      base = text.trim().length > 0
        ? await invoiceExtractionService.extract({ text })
        : await invoiceExtractionService.extract({ lines: [] });
    }

    if (extractionMethod === "ocr" && !templateDetected) {
      warnings.push("Invoice layout was not recognized; extracted values require manual review.");
    }

    /**
     * ------------------------------------------------------------
     * STEP 6 — Determine source
     * ------------------------------------------------------------
     *
     * "text" = embedded PDF text
     * "ocr"  = OCR from image
     */
    const source = extractionMethod === "ocr"
      ? "ocr" as ExtractedInvoice["source"]
      : "text" as ExtractedInvoice["source"];

    /**
     * ------------------------------------------------------------
     * STEP 7 — Return reviewable extraction result
     * ------------------------------------------------------------
     */
    logger.info({ traceId, stage: "document.extract.complete", items: base.items.length, warnings: warnings.length + base.warnings.length, durationMs: Date.now() - startedAt }, "Invoice document extraction completed");
    return {
      ...base,

      source,

      warnings: [
        ...warnings,
        ...base.warnings,
      ],

      document: {
        kind,

        fileName:
          file.originalName || null,

        sizeBytes:
          file.buffer.length,

        textExtracted,

        extractionMethod,

        ocrConfidence,
      },
    };
  },
};
