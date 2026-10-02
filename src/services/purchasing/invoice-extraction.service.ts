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
  source: "text" | "lines" | "document" | "ocr";
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

/**
 * Expands a printed year. Invoice tables very often print 2-digit years
 * ("06/30/27"), which must not be handed to Date.parse.
 */
function expandYear(value: string): number {
  const year = Number(value);
  if (value.length !== 2) return year;
  return year <= 79 ? 2000 + year : 1900 + year;
}

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
  // Both 2-digit and 4-digit years are accepted ("06/30/27", "15/03/2026").
  const numeric = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
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
    const date = new Date(
      Date.UTC(expandYear(numeric[3]!), month - 1, day),
    );
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

function toIsoDate(value: string): string | null {
  return toIsoInvoiceDate(value);
}

// ── column / table helpers ──────────────────────────────────────────────────

/** Splits a line into cells: tabs, pipes or runs of 2+ spaces separate cells. */
function splitColumns(line: string): string[] {
  return line
    .trim()
    .split(/\s{2,}|\t+|\s*\|\s*/)
    .filter(Boolean);
}

/** Printed date cell: 06/30/27, 30.06.2027, 2027-06-30. */
const DATE_CELL = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{4}[/-]\d{1,2}[/.-]\d{1,2}$/;

/** Numeric cell: 3500.00, 1,234.50, 3260068, 5. */
const NUMBER_CELL = /^-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^-?\d+(?:\.\d{1,2})?$/;

/** Unit-of-measure tokens printed in invoice tables. */
const UOM_TOKENS = new Set([
  "pc", "pcs", "piece", "pieces", "pk", "pkt", "pack", "packs",
  "packet", "packets", "pouch", "pouches", "box", "boxes", "btl",
  "bottle", "bottles", "tab", "tabs", "tablet", "tablets", "cap", "caps",
  "capsule", "capsules", "strip", "strips", "sachet", "sachets", "vial",
  "vials", "amp", "ampoule", "ampoules", "tube", "tubes", "bag", "bags",
  "can", "cans", "crate", "crates", "carton", "cartons", "ctn", "roll",
  "rolls", "rl", "doz", "dozen", "pair", "pairs", "set", "sets", "kg",
  "gm", "g", "mg", "ml", "l", "lt", "unit", "units", "drum", "barrel",
  "sheet", "sheets",
]);

/** Company suffixes/words that identify the supplier's letterhead line. */
const COMPANY_NAME_HINT =
  /\b(p\.?l\.?c|plc|ltd|limited|inc|llc|co|company|enterprise|enterprises|trading|import|importer|export|exporter|pharmaceutical|pharmaceuticals|pharma|distribution|distributors?|wholesale|business|group|s\.?c|share\s*company|industr(y|ies)|general|supply|supplies)\b/i;

/** Labels that mark a form field row rather than a line item. */
const FORM_LABEL =
  /\b(sub\s*city|kebele|bldg|fax|t\.?e\.?l|t\.?i\.?n|vat\s*reg|shop\s*\/?\s*store|sales\s*agent|representative|customer|id\s*no|account\s*(no|number)|bank|swift|branch|p\.?o\.?\s*box|credit\s*limit|amount\s+(joint|in\s+words)|non\s*tax)\b/;

/** True when a line looks like the supplier's letterhead company name. */
function looksLikeCompanyName(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (/\d/.test(trimmed)) return false;
  if (/[:|]/.test(trimmed)) return false;
  if (
    /^(invoice|sales?|credit|debit|delivery|receipt|quotation|proforma|purchase|order|tax|vat|amount|item|description|sub|grand|total|customer|cash|no|date|payment|terms|note|page)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const uppercaseRatio = trimmed.replace(/[^A-Z]/g, "").length / letters.length;
  return COMPANY_NAME_HINT.test(trimmed) || uppercaseRatio >= 0.8;
}

/** True when a row looks like a table row (several cells, several numbers). */
function looksLikeTableRow(line: string): boolean {
  const tokens = splitColumns(line);
  if (tokens.length < 3) return false;
  const numeric = tokens.filter(
    (token) => NUMBER_CELL.test(token) || DATE_CELL.test(token),
  );
  return numeric.length >= 2;
}

type TableColumns = {
  hasCode: boolean;
  hasBatch: boolean;
  hasExpiry: boolean;
  hasUnit: boolean;
};

/**
 * Detects a printed line-item table header
 * ("Item Description | Code | Batch # | Expr. Date | UOM | Quantity | Unit Price | Total Price")
 * and reports which columns exist, so the rows below can be mapped by column
 * instead of by blind token position.
 */
function detectTableHeader(line: string): TableColumns | null {
  const lower = normalizeInvoiceText(line);
  if (!/\b(descriptions?|items?|products?|particulars?)\b/.test(lower)) return null;
  if (!/\b(qty|quantity)\b/.test(lower)) return null;
  if (!/\b(price|amount|total|value)\b/.test(lower)) return null;
  if (!/\b(code|sku|batch|lot|exp\w*|uom|unit)\b/.test(lower)) return null;
  return {
    hasCode: /\b(code|sku|item\s*no|product\s*code)\b/.test(lower),
    hasBatch: /\b(batch|lot)\b/.test(lower),
    hasExpiry: /\b(exp\w*|expiry|expiration)\b/.test(lower),
    hasUnit: /\b(uom|unit|pack|measure)\b/.test(lower),
  };
}

function looksLikeUnit(token: string): boolean {
  const normalized = token.toLowerCase().replace(/[.\s]/g, "");
  return normalized.length > 0 && normalized.length <= 8 && UOM_TOKENS.has(normalized);
}

/** Dosage strength ("500mg", "100 ml", "10%") — never a code or a batch. */
const DOSE_CELL = /^\d+(?:[.,]\d+)?\s?(?:mcg|mg|g|kg|ml|cl|l|iu|i\.?u|%|mg\/ml)$/i;

/** Batch/lot cell: alphanumeric with digits ("3260068", "B-4471"). */
function looksLikeBatch(token: string): boolean {
  if (token.length < 3 || token.length > 24) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (DATE_CELL.test(token) || DOSE_CELL.test(token)) return false;
  return /^\d{4,}$/.test(token) || token.length >= 5;
}

/** Product/SKU cell: short, no spaces, carries a digit ("DI01", "1234"). */
function looksLikeCode(token: string): boolean {
  if (token.length < 2 || token.length > 24) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (DATE_CELL.test(token) || DOSE_CELL.test(token)) return false;
  // A bare 2–3 digit number is far more likely part of the description.
  return /[A-Za-z]/.test(token) || token.length >= 4;
}

type TableRow =
  | { kind: "item"; item: ExtractedInvoiceItem }
  | {
      kind: "amounts";
      quantity: number;
      unitPrice: number | null;
      lineTotal: number | null;
    }
  | { kind: "none" };

/**
 * Maps the cells printed left of the quantity column onto the columns declared
 * by the table header. Blank cells are simply absent from the row, so every
 * column is claimed right-to-left by matching that column's printed shape.
 */
function classifyTableHead(
  head: string[],
  columns: TableColumns,
): Pick<
  ExtractedInvoiceItem,
  "productCode" | "productName" | "unit" | "batchNumber" | "expiryDate"
> {
  const remaining = [...head];
  const take = (): string | undefined => remaining.pop();
  const peek = (): string | undefined => remaining[remaining.length - 1];

  let unit: string | null = null;
  let expiryDate: string | null = null;
  let batchNumber: string | null = null;
  let productCode: string | null = null;

  const unitCell = peek();
  if (columns.hasUnit && unitCell !== undefined && looksLikeUnit(unitCell)) {
    unit = take() ?? null;
  }

  const expiryCell = peek();
  if (columns.hasExpiry && expiryCell !== undefined && DATE_CELL.test(expiryCell)) {
    expiryDate = toIsoDate(take() ?? "");
  }

  const batchCell = peek();
  if (columns.hasBatch && batchCell !== undefined && looksLikeBatch(batchCell)) {
    batchNumber = take() ?? null;
  }

  const codeCell = peek();
  if (columns.hasCode && codeCell !== undefined && looksLikeCode(codeCell)) {
    productCode = take() ?? null;
  }

  const productName = remaining.join(" ").trim();

  return {
    productCode,
    productName: productName.length > 0 ? productName : null,
    unit,
    batchNumber,
    expiryDate,
  };
}

/** Parses one row of a detected line-item table. */
function parseTableRow(line: string, columns: TableColumns): TableRow {
  const tokens = splitColumns(line);
  if (tokens.length < 2) return { kind: "none" };

  const numeric: { index: number; value: number }[] = [];
  tokens.forEach((token, index) => {
    if (DATE_CELL.test(token)) return;
    if (!NUMBER_CELL.test(token)) return;
    const value = toNumber(token);
    if (value !== null) numeric.push({ index, value });
  });
  if (numeric.length < 3) return { kind: "none" };

  const trailing = numeric.slice(-3);
  const quantity = trailing[0]!.value;
  const unitPrice = trailing[1]!.value;
  const lineTotal = trailing[2]!.value;
  if (quantity <= 0) return { kind: "none" };

  // Split the cells into words: OCR often leaves a narrow column gap inside a
  // single cell ("DI01 3260068"), and the column shapes below are per word.
  const head = tokens
    .slice(0, trailing[0]!.index)
    .flatMap((cell) => cell.split(/\s+/))
    .filter(Boolean);
  if (head.length === 0) return { kind: "none" };

  const classified = classifyTableHead(head, columns);
  if (!classified.productName && !classified.productCode) {
    return { kind: "amounts", quantity, unitPrice, lineTotal };
  }

  return {
    kind: "item",
    item: {
      productCode: classified.productCode,
      productName: classified.productName,
      quantity,
      unit: classified.unit,
      unitPrice,
      lineTotal,
      batchNumber: classified.batchNumber,
      expiryDate: classified.expiryDate,
    },
  };
}

/** Header fields that identify the document: the first printed value wins. */
const FIRST_WINS_FIELDS: (keyof ParsedTotals)[] = [
  "invoiceNumber",
  "invoiceDate",
  "fsNumber",
  "supplierName",
  "supplierTin",
  "paymentTerms",
];

function mergeHeader(
  target: Partial<ParsedTotals>,
  parts: Partial<ParsedTotals>,
): void {
  for (const key of Object.keys(parts) as (keyof ParsedTotals)[]) {
    const value = parts[key];
    if (value === undefined || value === null) continue;
    const current = target[key];
    if (
      FIRST_WINS_FIELDS.includes(key) &&
      current !== undefined &&
      current !== null
    ) {
      continue;
    }
    (target as Record<string, unknown>)[key] = value;
  }
}

/** Header/footer field heuristics: label → value within one line. */
function parseHeaderLine(line: string): Partial<ParsedTotals> {
  const result: Partial<ParsedTotals> = {};
  const lower = normalizeInvoiceText(line);

  const grab = (pattern: RegExp): string | null => line.match(pattern)?.[1]?.trim() ?? null;

  const trailingNumber = (): number | null => {
    const match = line.match(/(\d[\d.,]*)\s*$/);
    return match ? toNumber(match[1]!) : null;
  };

  const isCustomerLine = /customer|buyer|bill\s*to|sold\s*to|client|consignee/.test(lower);
  const isVatRegistration =
    /(?:vat|tin|tax)\s*(?:reg|registration)\.?\s*(?:no|number|#)?\s*[:.]/.test(lower);

  // Invoice number, including the "Invoice No. : CR-00004217" printed form.
  if (/\binvoice\s*(?:no|number|num|#)\b/.test(lower)) {
    const value = grab(
      /invoice\s*(?:no|number|num|#)\.?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]*)/i,
    );
    if (value) result.invoiceNumber = value;
  }

  // Document date. A bare "Date" wins over "Expiry/Mfg/Valid date" labels.
  const dateLabel = /(dated|date)\b/gi;
  for (const match of line.matchAll(dateLabel)) {
    const start = match.index ?? 0;
    const before = line.slice(Math.max(0, start - 24), start);
    if (
      /(exp\w*|expr|mfg\w*|manufactur\w*|valid\w*|birth|deliver\w*|receipt|print\w*)[\s.:#-]*$/i.test(
        before,
      )
    ) {
      continue;
    }
    const raw = line
      .slice(start + match[1]!.length)
      .replace(/^\s*[:#-]?\s*/, "");
    const iso = toIsoDate(raw);
    if (iso) {
      result.invoiceDate = iso;
      break;
    }
  }

  if (/\bdue\s+date\b/.test(lower)) {
    const raw = grab(/due\s+date\s*[:-]?\s*(.+)$/i);
    const iso = raw ? toIsoDate(raw) : null;
    if (iso) result.paymentTerms = "CREDIT";
  }

  // Supplier TIN — never the buyer's TIN printed in the customer block.
  if (
    !isCustomerLine &&
    /\b(t\.?i\.?n\.?|vat\s*(?:no|number|#)|tax\s*(?:no|number|#))\b/.test(lower)
  ) {
    const value = grab(
      /(?:t\.?i\.?n\.?|vat\s*(?:no|number|#)|tax\s*(?:no|number|#))\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9-]*)/i,
    );
    if (value && value.length <= 30) result.supplierTin = value;
  }

  // Fiscal/folio slip number: "Fs No. : 00012242".
  if (/\bf\.?\s*s\.?\s*(?:no|number|num|#)?\b/.test(lower)) {
    const value = grab(
      /(?:^|\s)f\.?\s*s\.?\s*(?:no|number|num|#)?\.?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]*)/i,
    );
    if (value && value.length <= 30 && /\d/.test(value)) result.fsNumber = value;
  }

  if (
    /\bcredit\b/.test(lower) &&
    /\b(sale|sales|invoice|attachment|payment|terms|supply|delivery)\b/.test(lower)
  ) {
    result.paymentTerms = "CREDIT";
  }
  if (
    /\b(cash|no[ ]+credit|immediate)\b/.test(lower) &&
    /payment|sale|invoice|attachment/.test(lower)
  ) {
    result.paymentTerms = "NO_CREDIT";
  }
  if (/\bsub\s*total|subtotal\b/.test(lower)) {
    const value = trailingNumber();
    if (value !== null) result.subtotal = value;
  }
  // "Non Tax (%)" / "VAT 15%" totals, but never a VAT *registration* number.
  if (!isVatRegistration && /\b(tax|vat|gst)\b/.test(lower)) {
    const value = trailingNumber();
    if (value !== null) result.tax = value;
  }
  if (/\bdiscount\b/.test(lower)) {
    const value = trailingNumber();
    if (value !== null) result.discount = value;
  }
  if (/\b(fees?|freight|delivery|shipping|handling)\b/.test(lower)) {
    const value = trailingNumber();
    if (value !== null) result.fees = value;
  }
  if (/\b(grand\s*total|total\s+due|amount\s+due|invoice\s+total|balance\s+due)\b/.test(lower)) {
    const value = trailingNumber();
    if (value !== null) result.grandTotal = value;
  }
  if (
    result.supplierName === undefined &&
    !isCustomerLine &&
    /supplier|vendor|sold\s+by|from/.test(lower)
  ) {
    const value = grab(/(?:supplier|vendor|sold\s+by|from)\s*[:#-]\s*(.+)$/i);
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
    FORM_LABEL.test(lower) ||
    /^(page|invoice|supplier|vendor|customer|date|due|subtotal|sub total|total|grand|tax|vat|discount|payment|terms|bill|ship|thank|amount in)/.test(
      lower,
    )
  ) {
    return null;
  }
  // Needs at least one number to be a candidate line item.
  if (!/\d/.test(lower)) return null;

  const tokens = splitColumns(line);
  if (tokens.length < 2) return parseCompactItemLine(line) ?? null;

  // Numeric tokens (right-aligned columns) — quantity/price/total live at the end.
  const numeric = tokens
    .map((token, index) => ({ token, index, value: toNumber(token) }))
    .filter((entry): entry is { token: string; index: number; value: number } =>
      entry.value !== null && /[\d]/.test(entry.token),
    );
  if (numeric.length === 0) return null;

  const trailing = numeric.slice(-3); // up to [quantity, unitPrice, lineTotal]
  // A real line item prints a quantity and at least one amount; a single stray
  // number (a phone number, a street number, a page counter) is not one.
  if (trailing.length < 2) return null;
  const quantity = trailing[0]?.value ?? null;
  if (quantity === null || quantity <= 0) return null;
  const unitPrice = trailing[1]?.value ?? null;
  const lineTotal = trailing[2]?.value ?? null;

  // Description = everything before the first trailing numeric token; a leading
  // alphanumeric token of <= 30 chars that looks like a code is the SKU.
  const firstNumericIndex = trailing[0]!.index;
  const head = tokens.slice(0, firstNumericIndex);
  if (head.length === 0) return null;
  // A row that only carries a unit code and amounts is a continuation of the
  // item above it, not a product named "PK".
  if (head.length === 1 && looksLikeUnit(head[0]!)) return null;

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
  notes: string[];
} {
  const header: Partial<ParsedTotals> = {};
  const items: ExtractedInvoiceItem[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let scanned = 0;
  let table: TableColumns | null = null;
  let duplicateRows = 0;
  let amountOnlyRows = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    scanned += 1;

    // A printed line-item table header switches the parser into column mode.
    const tableColumns = detectTableHeader(line);
    if (tableColumns) {
      table = tableColumns;
      continue;
    }

    const headerParts = parseHeaderLine(line);
    if (Object.keys(headerParts).length > 0) {
      mergeHeader(header, headerParts);
      continue;
    }

    if (table) {
      const row = parseTableRow(line, table);
      if (row.kind === "item") {
        items.push(row.item);
        continue;
      }
      if (row.kind === "amounts") {
        const previous = items[items.length - 1];
        if (
          previous &&
          previous.quantity === row.quantity &&
          previous.unitPrice === row.unitPrice &&
          previous.lineTotal === row.lineTotal
        ) {
          duplicateRows += 1;
        } else {
          amountOnlyRows += 1;
        }
        continue;
      }
    }

    // Supplier letterhead: the first prominent company-looking line.
    if (!header.supplierName && !table && scanned <= 15 && looksLikeCompanyName(line)) {
      header.supplierName = line.replace(/\s+/g, " ").trim();
      continue;
    }

    const item = parseItemLine(line);
    if (item) {
      items.push(item);
    } else if (looksLikeTableRow(line)) {
      skipped += 1;
    }
  }

  if (duplicateRows > 0) {
    notes.push(
      `${duplicateRows} line(s) repeat the previous line item and were ignored; add them manually if they are separate batches`,
    );
  }
  if (amountOnlyRows > 0) {
    notes.push(
      `${amountOnlyRows} line(s) show quantities and amounts without a product description; add them manually`,
    );
  }

  return { header, items, skipped, notes };
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

    const {
      header,
      items: parsedItems,
      skipped,
      notes,
    } = parseTextLines(textLines);
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
    warnings.push(...notes);

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
