import { z } from "zod";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { normalizeInvoiceText } from "./invoice-receiving.service.js";

/**
 * ============================================================================
 * Supplier invoice document extraction
 * ============================================================================
 *
 * Turns a raw supplier invoice / delivery document into the normalized,
 * USER-REVIEWABLE invoice payload consumed by the invoice-upload endpoints
 * (`POST /purchase-orders/:id/invoice-upload[/confirm]`).
 *
 * Design rules (mirroring the invoice-receiving architecture):
 *  - Extraction is a PURE transformation. It never touches the database and
 *    never mutates inventory, PO quantities, receipts or invoices.
 *  - Extracted data is UNTRUSTED: the receiving flow re-matches and
 *    re-validates everything at confirmation time. This layer only proposes
 *    values for the user to review and correct.
 *  - The repository has no OCR dependency on purpose (no paid external AI/OCR
 *    service). An OCR adapter can run OUTSIDE the backend and POST the same
 *    text/lines here for normalization, or POST its result directly to the
 *    upload endpoints. This service normalizes whatever produced the text.
 *
 * Two input shapes are accepted:
 *  - `text`:      raw document text (lines separated by \n).
 *  - `lines`:     pre-split document lines (e.g. from an OCR adapter).
 *  - `document`:  an already-parsed draft to validate/normalize (e.g. from a
 *                 frontend parsing library), passthrough with corrections.
 */

export type ExtractedInvoiceItem = {
  /** SKU / product code printed on the line, if any. */
  productCode: string | null;
  /** Free-text product description printed on the line. */
  productName: string | null;
  quantity: number;
  /** Unit name/symbol as printed (never converted server-side). */
  unit: string | null;
  unitPrice: number | null;
  /** Line total as printed; used for review only. */
  lineTotal: number | null;
  batchNumber: string | null;
  expiryDate: string | null;
};

export type ExtractedInvoice = {
  source: "text" | "lines" | "document";
  supplierName: string | null;
  /** Supplier Tax Identification Number printed on the document (optional). */
  supplierTin: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** Fiscal/folio slip number printed on the document (optional). */
  fsNumber: string | null;
  items: ExtractedInvoiceItem[];
  /** Number of document lines that were skipped (headers, totals, noise). */
  skippedLineCount: number;
  warnings: string[];
  subtotal: number | null;
  discount: number | null;
  tax: number | null;
  fees: number | null;
  grandTotal: number | null;
  paymentTerms: "CREDIT" | "NO_CREDIT" | null;
};

/** Line shape accepted from an OCR adapter / frontend parser. */
const documentLineSchema = z.object({
  productCode: z.string().trim().max(100).nullish(),
  productName: z.string().trim().max(300).nullish(),
  quantity: z.number().nonnegative().nullish(),
  unit: z.string().trim().max(50).nullish(),
  unitPrice: z.number().nonnegative().nullish(),
  lineTotal: z.number().nullish(),
  batchNumber: z.string().trim().max(100).nullish(),
  expiryDate: z.string().trim().max(40).nullish(),
});

const extractionRequestSchema = z
  .object({
    text: z.string().max(200_000).optional(),
    lines: z.array(z.union([z.string().max(500), documentLineSchema])).max(5_000).optional(),
    document: z
      .object({
        supplierName: z.string().trim().max(200).nullish(),
        supplierTin: z.string().trim().max(30).nullish(),
        invoiceNumber: z.string().trim().max(100).nullish(),
        invoiceDate: z.string().trim().max(40).nullish(),
        fsNumber: z.string().trim().max(30).nullish(),
        items: z.array(documentLineSchema).max(5_000).optional(),
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

// ── text parsing helpers ────────────────────────────────────────────────────

function toNumber(value: string): number | null {
  // Tolerate thousand separators and comma decimals ("1,234.50" / "1234,50").
  const cleaned = value.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

type ParsedTotals = {
  subtotal: number | null;
  discount: number | null;
  tax: number | null;
  fees: number | null;
  grandTotal: number | null;
  paymentTerms: "CREDIT" | "NO_CREDIT" | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  supplierName: string | null;
  supplierTin: string | null;
  fsNumber: string | null;
};

/**
 * Normalizes a printed invoice date into an ISO string. Handles the formats
 * commonly found on pharmacy supplier invoices:
 *   ISO (2030-06-30...), "Aug 20,2026 12:18", "20/08/2026", "08/20/2026",
 *   "20-08-2026", "20.08.2026".
 *
 * Ambiguity rule: a D/M/Y vs M/D/Y conflict is resolved as DAY-FIRST unless
 * the value is impossible as day-first (first component > 12), which is the
 * dominant format on Ethiopian/regional supplier documents.
 */
const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

export function toIsoInvoiceDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // ISO already?
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // "Aug 20,2026 12:18" / "Aug 20 2026" / "August 20, 2026"
  const monthName = trimmed.match(
    /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s*(\d{4})/,
  );
  if (monthName) {
    const monthIndex = MONTH_NAMES.indexOf(monthName[1]!.toLowerCase().slice(0, 3));
    if (monthIndex >= 0) {
      const date = new Date(Date.UTC(Number(monthName[3]), monthIndex, Number(monthName[2])));
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }

  // Numeric day/month/year with any separator (ambiguity-aware).
  const numeric = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    let day = first;
    let month = second;
    if (first > 12) {
      // Must be day-first (e.g. 20/08/2026).
      day = first;
      month = second;
    } else if (second > 12) {
      // Cannot be day-first -> month-first US style (e.g. 06/30/2030).
      day = second;
      month = first;
    }
    const date = new Date(Date.UTC(Number(numeric[3]), month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

function toIsoDate(value: string): string | null {
  return toIsoInvoiceDate(value);
}

/** Header/footer field heuristics: label → value within one line. */
function parseHeaderLine(line: string): Partial<ParsedTotals> {
  const result: Partial<ParsedTotals> = {};
  const lower = normalizeInvoiceText(line);

  const grab = (pattern: RegExp): string | null => line.match(pattern)?.[1]?.trim() ?? null;

  if (/\binvoice\s*(no|number|#)\b/.test(lower)) {
    const value = grab(/invoice\s*(?:no|number|#)\s*[:-]?\s*(\S+)/i);
    if (value) result.invoiceNumber = value;
  }
  if (/\b(date|dated)\b/.test(lower) && !/\bdue\b/.test(lower)) {
    const raw = grab(/(?:date|dated)\s*[:-]?\s*(.+)$/i);
    const iso = raw ? toIsoDate(raw) : null;
    if (iso) result.invoiceDate = iso;
  }
  if (/\bdue\s+date\b/.test(lower)) {
    const raw = grab(/due\s+date\s*[:-]?\s*(.+)$/i);
    const iso = raw ? toIsoDate(raw) : null;
    if (iso && /\b(credit|net)\b/.test(lower)) result.paymentTerms = "CREDIT";
  }
  if (/\b(t\.?i\.?n\.?|vat\s*(?:no|number|#)|tax\s*(?:no|number|#))\b/.test(lower)) {
    const value = grab(/(?:t\.?i\.?n\.?|vat\s*(?:no|number|#)|tax\s*(?:no|number|#))\s*[:-]?\s*(\S+)/i);
    if (value && value.length <= 30) result.supplierTin = value;
  }
  if (/\b(f\.?s\.?(?:\s*(?:no|number|#))?)\b/.test(lower)) {
    const value = grab(/f\.?s\.?(?:\s*(?:no|number|#))?\s*[:-]?\s*(\S+)/i);
    if (value && value.length <= 30 && /\d/.test(value)) result.fsNumber = value;
  }
  if (/\b(cash|no[ ]+credit|immediate)\b/.test(lower) && /payment/.test(lower)) {
    result.paymentTerms = "NO_CREDIT";
  }
  if (/\bsub\s*total|subtotal\b/.test(lower)) {
    const match = line.match(/([\d.,]+)\s*$/);
    const value = match ? toNumber(match[1]) : null;
    if (value !== null) result.subtotal = value;
  }
  if (/\b(tax|vat|gst)\b/.test(lower)) {
    const match = line.match(/([\d.,]+)\s*$/);
    const value = match ? toNumber(match[1]) : null;
    if (value !== null) result.tax = value;
  }
  if (/\bdiscount\b/.test(lower)) {
    const match = line.match(/([\d.,]+)\s*$/);
    const value = match ? toNumber(match[1]) : null;
    if (value !== null) result.discount = value;
  }
  if (/\b(fees?|freight|delivery|shipping|handling)\b/.test(lower)) {
    const match = line.match(/([\d.,]+)\s*$/);
    const value = match ? toNumber(match[1]) : null;
    if (value !== null) result.fees = value;
  }
  if (/\b(grand\s*total|total\s+due|amount\s+due|invoice\s+total|balance\s+due)\b/.test(lower)) {
    const match = line.match(/([\d.,]+)\s*$/);
    const value = match ? toNumber(match[1]) : null;
    if (value !== null) result.grandTotal = value;
  }
  if (result.supplierName === undefined && /supplier|from|vendor|sold\s+by/.test(lower)) {
    const value = grab(/(?:supplier|vendor|sold\s+by)\s*[:-]\s*(.+)$/i);
    if (value && value.length <= 200) result.supplierName = value;
  }
  return result;
}

/**
 * Parses a single-space line (common in PDF text layers and plain OCR output):
 *   "FINS-01 FINALERGE 100ML 12 x 427.50 5130.00 EXP:06/30/2030"
 * The trailing numbers are read right-to-left [total, unitPrice, "x", qty] and
 * everything before the quantity becomes code + description.
 */
function parseCompactItemLine(line: string): ExtractedInvoiceItem | null {
  let working = line.trim();

  // Trailing expiry first, so its numbers are not mistaken for money columns.
  let expiryDate: string | null = null;
  const expMatch = working.match(/\s(?:exp(?:iry)?|best[ ]+before)[ :.]?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\s*$/i);
  if (expMatch) {
    expiryDate = toIsoDate(expMatch[1]!);
    working = working.slice(0, expMatch.index).trim();
  }

  // Trailing numeric tail: ... QTY x UNIT_PRICE LINE_TOTAL
  const tail = working.match(
    /^(.*?)[\s|]+(\d{1,6}(?:[.,]\d{1,3})?)[\s|]+x[\s|]+([\d.,]+)[\s|]+([\d.,]+)\s*$/i,
  );
  if (!tail) return null;

  const quantity = toNumber(tail[2]!);
  const unitPrice = toNumber(tail[3]!);
  const lineTotal = toNumber(tail[4]!);
  if (quantity === null || quantity <= 0) return null;

  const head = tail[1]!.trim();
  if (!head) return null;

  // Leading code: short token containing a digit or dash.
  const headTokens = head.split(/\s+/);
  let productCode: string | null = null;
  let productName: string;
  const first = headTokens[0]!;
  if (headTokens.length >= 2 && /^[\w-]{1,30}$/.test(first) && /[\d-]/.test(first)) {
    productCode = first;
    productName = headTokens.slice(1).join(" ");
  } else {
    productName = head;
  }
  if (!productName) return null;

  return { productCode, productName, quantity, unit: null, unitPrice, lineTotal, batchNumber: null, expiryDate };
}

/** Line-item heuristics: "CODE NAME... QTY UNIT x PRICE = TOTAL" or tabular. */
function parseItemLine(line: string): ExtractedInvoiceItem | null {
  // Skip totals/headers and obvious noise.
  const lower = normalizeInvoiceText(line);
  if (
    !lower ||
    lower.length < 3 ||
    /^(page|invoice|supplier|vendor|customer|date|due|subtotal|sub total|total|grand|tax|vat|discount|payment|terms|bill|ship|thank|amount in)/.test(
      lower,
    )
  ) {
    return null;
  }
  // Needs at least one number to be a candidate line item.
  if (!/\d/.test(lower)) return null;

  const tokens = line.trim().split(/\s{2,}|\t+|\s*\|\s*/).filter(Boolean);
  if (tokens.length < 2) return parseCompactItemLine(line) ?? null;

  // Numeric tokens (right-aligned columns) — quantity/price/total live at the end.
  const numeric = tokens
    .map((token, index) => ({ token, index, value: toNumber(token) }))
    .filter((entry): entry is { token: string; index: number; value: number } =>
      entry.value !== null && /[\d]/.test(entry.token),
    );
  if (numeric.length === 0) return null;

  const trailing = numeric.slice(-3); // up to [quantity, unitPrice, lineTotal]
  const quantity = trailing[0]?.value ?? null;
  if (quantity === null || quantity <= 0) return null;
  const unitPrice = trailing[1]?.value ?? null;
  const lineTotal = trailing[2]?.value ?? null;

  // Description = everything before the first trailing numeric token; a leading
  // alphanumeric token of <= 30 chars that looks like a code is the SKU.
  const firstNumericIndex = trailing[0]!.index;
  const head = tokens.slice(0, firstNumericIndex);
  if (head.length === 0) return null;

  let productCode: string | null = null;
  let productName: string | null;
  const first = head[0]!;
  if (head.length >= 2 && /^[\w-]{1,30}$/.test(first) && /[\d-]/.test(first)) {
    productCode = first;
    productName = head.slice(1).join(" ");
  } else {
    productName = head.join(" ");
  }
  if (!productName) return null;

  // Batch / expiry often printed at the end of the description or as a tail token.
  let batchNumber: string | null = null;
  let expiryDate: string | null = null;
  const tail = tokens[tokens.length - 1] ?? "";
  const batchMatch = tail.match(/^(?:b(?:atch)?[.:#]?\s*)?([A-Z0-9][A-Z0-9-]{2,})$/i);
  if (batchMatch && !/[\d.,]/.test(tail.replace(batchMatch[1]!, ""))) {
    batchNumber = batchMatch[1]!;
  }
  const expMatch = line.match(/(?:exp(?:iry)?|best[ ]+before)[ :]?\s*([\d]{1,2}[/.-][\d]{1,2}[/.-][\d]{2,4}|\d{4}-\d{2}-\d{2})/i);
  if (expMatch) expiryDate = toIsoDate(expMatch[1]!);

  return {
    productCode,
    productName,
    quantity,
    unit: null,
    unitPrice,
    lineTotal,
    batchNumber,
    expiryDate,
  };
}

function parseTextLines(lines: string[]): {
  header: Partial<ParsedTotals>;
  items: ExtractedInvoiceItem[];
  skipped: number;
} {
  const header: Partial<ParsedTotals> = {};
  const items: ExtractedInvoiceItem[] = [];
  let skipped = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const headerParts = parseHeaderLine(line);
    if (Object.keys(headerParts).length > 0) {
      Object.assign(header, headerParts);
      continue;
    }
    const item = parseItemLine(line);
    if (item) {
      items.push(item);
    } else {
      skipped += 1;
    }
  }
  return { header, items, skipped };
}

// ── service ─────────────────────────────────────────────────────────────────

export const invoiceExtractionService = {
  /**
   * Normalizes a raw invoice document into the review payload. Pure function:
   * no database access, no mutation, no side effects. Output is a PROPOSAL for
   * user review — never persisted and never applied anywhere by itself.
   */
  async extract(raw: unknown): Promise<ExtractedInvoice> {
    const parsed = extractionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, "Invalid extraction request", {
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;
    const warnings: string[] = [];

    // ── already-parsed document: normalize + passthrough ────────────────────
    if (input.document) {
      const doc = input.document;
      const items: ExtractedInvoiceItem[] = (doc.items ?? []).map((item) => ({
        productCode: item.productCode ?? null,
        productName: item.productName ?? null,
        quantity: item.quantity ?? 0,
        unit: item.unit ?? null,
        unitPrice: item.unitPrice ?? null,
        lineTotal: item.lineTotal ?? null,
        batchNumber: item.batchNumber ?? null,
        expiryDate: item.expiryDate ? toIsoDate(item.expiryDate) : null,
      }));
      items.forEach((item, index) => {
        if (!item.productName && !item.productCode) {
          warnings.push(`Line ${index + 1} has no product identifier`);
        }
        if (item.quantity <= 0) {
          warnings.push(`Line ${index + 1} has a non-positive quantity`);
        }
        if (item.expiryDate === null && item.expiryDate !== null) {
          warnings.push(`Line ${index + 1} has an unreadable expiry date`);
        }
      });
      return {
        source: "document",
        supplierName: doc.supplierName ?? null,
        supplierTin: doc.supplierTin ?? null,
        invoiceNumber: doc.invoiceNumber ?? null,
        invoiceDate: doc.invoiceDate ?? null,
        fsNumber: doc.fsNumber ?? null,
        items,
        skippedLineCount: 0,
        warnings,
        subtotal: doc.subtotal ?? null,
        discount: doc.discount ?? null,
        tax: doc.tax ?? null,
        fees: doc.fees ?? null,
        grandTotal: doc.grandTotal ?? null,
        paymentTerms: doc.paymentTerms ?? null,
      };
    }

    // ── text / lines: heuristic parse ───────────────────────────────────────
    let textLines: string[] = [];
    const structuredLines: ExtractedInvoiceItem[] = [];
    if (input.text !== undefined) {
      textLines = input.text.split(/\r?\n/);
    }
    if (input.lines !== undefined) {
      for (const line of input.lines) {
        if (typeof line === "string") textLines.push(line);
        else {
          structuredLines.push({
            productCode: line.productCode ?? null,
            productName: line.productName ?? null,
            quantity: line.quantity ?? 0,
            unit: line.unit ?? null,
            unitPrice: line.unitPrice ?? null,
            lineTotal: line.lineTotal ?? null,
            batchNumber: line.batchNumber ?? null,
            expiryDate: line.expiryDate ? toIsoDate(line.expiryDate) : null,
          });
        }
      }
    }

    const { header, items: parsedItems, skipped } = parseTextLines(textLines);
    const items = [...structuredLines, ...parsedItems];

    if (items.length === 0) {
      warnings.push(
        "No line items could be recognized in the document; enter them manually or adjust the extraction",
      );
    }
    if (skipped > 0) {
      warnings.push(`${skipped} document line(s) could not be interpreted and were skipped`);
    }
    if (!header.invoiceNumber) {
      warnings.push("Invoice number was not found in the document");
    }

    return {
      source: input.text !== undefined ? "text" : "lines",
      supplierName: header.supplierName ?? null,
      supplierTin: header.supplierTin ?? null,
      invoiceNumber: header.invoiceNumber ?? null,
      invoiceDate: header.invoiceDate ?? null,
      fsNumber: header.fsNumber ?? null,
      items,
      skippedLineCount: skipped,
      warnings,
      subtotal: header.subtotal ?? null,
      discount: header.discount ?? null,
      tax: header.tax ?? null,
      fees: header.fees ?? null,
      grandTotal: header.grandTotal ?? null,
      paymentTerms: header.paymentTerms ?? null,
    };
  },
};

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;
