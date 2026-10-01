import { PDFParse } from "pdf-parse";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import {
  invoiceExtractionService,
  type ExtractedInvoice,
} from "./invoice-extraction.service.js";

/**
 * ============================================================================
 * Invoice document upload extraction (multipart file -> normalized JSON)
 * ============================================================================
 *
 * Accepts an ACTUAL supplier invoice document (PDF/JPEG/PNG/WEBP), validates it
 * safely, extracts what it can, and hands the result to the existing
 * invoice-extraction normalizer. The output stays a USER-REVIEWABLE PROPOSAL:
 * nothing is persisted, no SupplierInvoice is created, and the confirm-time
 * revalidation in invoice-receiving.service.ts is unchanged.
 *
 * Extraction strategy (deliberately no external OCR/AI dependency):
 *  - PDF:      pdf-parse extracts embedded text; the existing text heuristics
 *              parse header/items/totals from it.
 *  - Images:   JPEG/PNG/WEBP have no embedded text layer. The file is
 *              validated and echoed back as metadata with a warning that a
 *              text layer is unavailable, so the user reviews/enters values —
 *              the same contract as an OCR adapter running out-of-process.
 *
 * Security:
 *  - Magic-byte sniffing (never trust the client MIME/filename).
 *  - Hard size cap (checked before AND after multer's limit).
 *  - Text layer treated as untrusted input, same as any request body.
 *  - Nothing is written to disk: files live only in memory for the request.
 */

/** 10 MB — comfortably above a phone photo of an invoice, small enough to be safe. */
export const MAX_INVOICE_FILE_BYTES = 10 * 1024 * 1024;

type SupportedKind = "pdf" | "jpeg" | "png" | "webp";

const SUPPORTED: Record<SupportedKind, { mime: string[]; extensions: string[]; label: string }> = {
  pdf: { mime: ["application/pdf"], extensions: [".pdf"], label: "PDF" },
  jpeg: { mime: ["image/jpeg", "image/jpg"], extensions: [".jpg", ".jpeg"], label: "JPEG" },
  png: { mime: ["image/png"], extensions: [".png"], label: "PNG" },
  webp: { mime: ["image/webp"], extensions: [".webp"], label: "WEBP" },
};

function magicKind(bytes: Uint8Array): SupportedKind | null {
  // %PDF-
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
  ) {
    return "pdf";
  }
  // FF D8 FF (JPEG SOI + first marker)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  // 89 50 4E 47 0D 0A 1A 0A (PNG signature)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  // "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function extensionKind(filename: string | undefined): SupportedKind | null {
  if (!filename) return null;
  const lower = filename.toLowerCase();
  for (const [kind, spec] of Object.entries(SUPPORTED)) {
    if (spec.extensions.some((ext) => lower.endsWith(ext))) {
      return kind as SupportedKind;
    }
  }
  return null;
}

export type UploadedInvoiceFile = {
  /** Original client filename (informational, never used as a storage path). */
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
};

/**
 * Validates an uploaded document. Enforced in order:
 *   1. non-empty
 *   2. size cap
 *   3. magic bytes match a supported format
 *   4. declared MIME type / extension are not for a DIFFERENT format
 * (an unknown declared type is tolerated; a contradictory one is not).
 */
export function validateInvoiceFile(file: UploadedInvoiceFile): SupportedKind {
  if (!file.buffer || file.buffer.length === 0) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, "Uploaded file is empty");
  }
  if (file.size > MAX_INVOICE_FILE_BYTES || file.buffer.length > MAX_INVOICE_FILE_BYTES) {
    throw new AppError(
      413,
      ErrorCode.VALIDATION_ERROR,
      `Invoice document exceeds the ${Math.round(MAX_INVOICE_FILE_BYTES / (1024 * 1024))} MB size limit`,
    );
  }

  const kind = magicKind(file.buffer.subarray(0, 16));
  if (!kind) {
    throw new AppError(
      415,
      ErrorCode.VALIDATION_ERROR,
      "Unsupported invoice document: expected PDF, JPEG, PNG or WEBP content",
    );
  }

  const declared = file.mimeType.toLowerCase();
  const declaredOk =
    SUPPORTED[kind].mime.includes(declared) || declared === "" || declared === "application/octet-stream";
  const extOk =
    extensionKind(file.originalName) === null || extensionKind(file.originalName) === kind;
  if (!declaredOk || !extOk) {
    throw new AppError(
      415,
      ErrorCode.VALIDATION_ERROR,
      "Declared file type does not match the actual document content",
    );
  }

  return kind;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

export type InvoiceDocumentExtraction = ExtractedInvoice & {
  document: {
    /** Detected content kind (from magic bytes, not the client). */
    kind: SupportedKind;
    fileName: string | null;
    sizeBytes: number;
    /** True when text was embedded in the document (PDF) and parsed. */
    textExtracted: boolean;
  };
};

export const invoiceDocumentService = {
  /**
   * Full pipeline for an uploaded invoice document:
   * validate -> extract text (PDF) or flag image -> normalize via the existing
   * extraction service. Pure transformation: no database, no persistence.
   */
  async extractFromFile(file: UploadedInvoiceFile): Promise<InvoiceDocumentExtraction> {
    const kind = validateInvoiceFile(file);

    let text = "";
    const warnings: string[] = [];
    let textExtracted = false;

    if (kind === "pdf") {
      try {
        text = await extractPdfText(file.buffer);
        textExtracted = text.trim().length > 0;
        if (!textExtracted) {
          warnings.push(
            "The PDF contains no extractable text (likely a scanned image); enter the invoice details manually or use an OCR adapter",
          );
        }
      } catch {
        throw new AppError(
          422,
          ErrorCode.VALIDATION_ERROR,
          "The PDF document could not be read (corrupted or password-protected)",
        );
      }
    } else {
      warnings.push(
        `${SUPPORTED[kind].label} images carry no machine-readable text; the file was validated but OCR must supply the content for review`,
      );
    }

    // Existing normalizer parses the untrusted text with the same heuristics
    // used for pasted text/lines — OCR output is just untrusted input.
    const base =
      text.trim().length > 0
        ? await invoiceExtractionService.extract({ text })
        : await invoiceExtractionService.extract({ lines: [] });

    return {
      ...base,
      source: "text",
      warnings: [...warnings, ...base.warnings],
      document: {
        kind,
        fileName: file.originalName || null,
        sizeBytes: file.buffer.length,
        textExtracted,
      },
    };
  },
};
