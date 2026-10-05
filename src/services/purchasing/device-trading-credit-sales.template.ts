import type { OcrWord } from "./invoice-ocr.service.js";
import type { ExtractedInvoice, ExtractedInvoiceItem } from "./invoice-extraction.service.js";
import { logger } from "../../config/logger.js";

/**
 * DEVICE TRADING PLC - CREDIT SALES ATTACHMENT (photographed paper invoice)
 *
 * Everything here is RESOLUTION-INDEPENDENT. The OCR layer normalizes photos
 * but never enlarges them (TESSERACT_TARGET_WIDTH is an upper bound only), so
 * no absolute pixel value may appear in this file: all thresholds are
 * fractions of the page size, and the table is located from its own header row
 * instead of fixed Y coordinates.
 *
 * Photos are skewed, so rows are grouped on a slope-corrected Y
 * (adjustedY) estimated from the printed table header.
 */

export type PageSize = { width: number; height: number };

type WordRow = { words: OcrWord[]; adjustedY: number };

/** Column boundaries as fractions of page width (Description ... Total Price). */
const TABLE_X = [
  0.0537, 0.2783, 0.3467, 0.4443, 0.5469, 0.6348, 0.6934, 0.7852, 0.8643, 0.999,
] as const;

const FALLBACK_SLOPE = -0.035; // rows rise toward the right in a typical photo
const ROW_TOLERANCE = 0.0127; // fraction of page height
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

/* ------------------------------ helpers ------------------------------ */

const cx = (w: OcrWord) => w.left + w.width / 2;
const cy = (w: OcrWord) => w.top + w.height / 2;

const compact = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");

function cleanCell(v: string): string {
  return v
    .replace(/[|¦]/g, "")
    .replace(/^[^A-Za-z0-9.-]+/, "")
    .replace(/[^A-Za-z0-9./:%-]+$/, "")
    .trim();
}

function parseNumber(v: string): number | null {
  const s = cleanCell(v).replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const isNumeric = (v: string) => /^\d+(?:\.\d+)?$/.test(cleanCell(v).replace(/,/g, ""));

function isNoise(w: OcrWord): boolean {
  const t = w.text.trim();
  return !t || /^[|¦_\\{}[\]~`=\-—–:.,;'"‘’]+$/.test(t);
}

function pageSize(words: OcrWord[], given?: PageSize): PageSize {
  if (given && given.width > 0 && given.height > 0) return given;
  return {
    width: Math.max(1, ...words.map((w) => w.right)),
    height: Math.max(1, ...words.map((w) => w.bottom)),
  };
}

/* --------------------------- digit repair ---------------------------- */

/** Digit pairs Tesseract routinely swaps on smudged/photographed print. */
const CONFUSABLE: Record<string, string> = {
  "0": "86", "1": "7", "3": "85", "5": "683", "6": "580", "8": "0356", "9": "84", "4": "9", "7": "1",
};

/** True when `read` differs from `expected` only by visually-confusable digits. */
function looksLikeMisread(read: number, expected: number): boolean {
  const a = read.toFixed(2);
  const b = expected.toFixed(2);
  if (a === b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (!(CONFUSABLE[a[i]!] ?? "").includes(b[i]!)) return false;
    diff += 1;
  }
  return diff > 0 && diff <= 2;
}

/* ------------------------------ dates -------------------------------- */

function parseSlashDate(v: string): string | null {
  const m = cleanCell(v).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Date : Aug 20.2026 12:16"  (OCR often turns the space into a dot). */
function extractInvoiceDate(words: OcrWord[], page: PageSize): string | null {
  const label = words.find(
    (w) => /^date:?$/i.test(cleanCell(w.text)) && cy(w) < page.height * 0.45,
  );
  if (!label) return null;

  const sameLine = words
    .filter((w) => w.left > label.right && Math.abs(cy(w) - cy(label)) <= page.height * 0.02)
    .sort((a, b) => a.left - b.left);

  // Stop at the next printed label ("Fs No.") so its text never leaks in.
  const stop = sameLine.findIndex((w) => /^fs$/i.test(cleanCell(w.text)));
  const text = (stop >= 0 ? sameLine.slice(0, stop) : sameLine)
    .map((w) => cleanCell(w.text))
    .filter(Boolean)
    .join(" ");

  const m = text.match(/([A-Za-z]{3,})\s*(\d{1,2})[.\s/,-]+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4] ?? 0), Number(m[5] ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ------------------------------ header ------------------------------- */

export function isDeviceTradingCreditSalesTemplate(words: OcrWord[]): boolean {
  const t = words.map((w) => compact(w.text));
  return (
    t.includes("device") &&
    t.includes("trading") &&
    t.includes("plc") &&
    words.some((w) => /^cr-?\d+$/i.test(cleanCell(w.text)))
  );
}

function extractSupplierName(words: OcrWord[], page: PageSize): string | null {
  const found = words
    .filter((w) => ["device", "trading", "plc"].includes(compact(w.text)) && cy(w) < page.height * 0.12)
    .sort((a, b) => a.left - b.left);
  return found.length >= 3 ? found.map((w) => cleanCell(w.text).toUpperCase()).join(" ") : null;
}

function extractInvoiceNumber(words: OcrWord[]): string | null {
  const hit = words
    .filter((w) => /^cr-?\d+$/i.test(cleanCell(w.text)))
    .sort((a, b) => a.top - b.top)[0];
  if (!hit) return null;
  const v = cleanCell(hit.text).toUpperCase();
  return v.includes("-") ? v : v.replace(/^CR/, "CR-");
}

function extractFsNumber(words: OcrWord[], page: PageSize): string | null {
  const label = words.find((w) => /^fs$/i.test(cleanCell(w.text)) && cy(w) < page.height * 0.45);
  if (!label) return null;
  const hit = words
    .filter((w) => w.left > label.right && Math.abs(cy(w) - cy(label)) <= page.height * 0.025)
    .sort((a, b) => a.left - b.left)
    .find((w) => /^\d{5,}$/.test(cleanCell(w.text)));
  return hit ? cleanCell(hit.text) : null;
}

/* --------------------------- table geometry -------------------------- */

const HEADER_WORDS = /^(item|description|batch|exp|expr|mfg|uom|quantity|qty|unit|price)$/;

/**
 * Finds the printed table header and estimates the photo's row slope from it.
 * Returns the slope-corrected Y of the header line.
 */
function locateHeader(words: OcrWord[], page: PageSize): { slope: number; adjustedY: number } | null {
  const anchor = words.find((w) => compact(w.text) === "quantity" || compact(w.text) === "qty");
  if (!anchor) return null;

  const band = page.height * 0.1;
  const header = words.filter(
    (w) => HEADER_WORDS.test(compact(w.text)) && Math.abs(cy(w) - cy(anchor)) <= band,
  );
  if (header.length < 3) return null;

  // Least-squares slope of header centres; fall back when the span is too short.
  const n = header.length;
  const mx = header.reduce((s, w) => s + cx(w), 0) / n;
  const my = header.reduce((s, w) => s + cy(w), 0) / n;
  const den = header.reduce((s, w) => s + (cx(w) - mx) ** 2, 0);
  const span = Math.max(...header.map(cx)) - Math.min(...header.map(cx));
  let slope = den > 0 && span > page.width * 0.4
    ? header.reduce((s, w) => s + (cx(w) - mx) * (cy(w) - my), 0) / den
    : FALLBACK_SLOPE;
  slope = Math.max(-0.12, Math.min(0.12, slope));

  const ys = header.map((w) => cy(w) - cx(w) * slope).sort((a, b) => a - b);
  return { slope, adjustedY: ys[Math.floor(ys.length / 2)]! };
}

function groupRows(words: OcrWord[], slope: number, tolerance: number): WordRow[] {
  const adj = (w: OcrWord) => cy(w) - cx(w) * slope;
  const rows: WordRow[] = [];
  for (const w of [...words].sort((a, b) => adj(a) - adj(b) || a.left - b.left)) {
    const y = adj(w);
    let best: WordRow | null = null;
    let bestD = Infinity;
    for (const r of rows) {
      const d = Math.abs(y - r.adjustedY);
      if (d <= tolerance && d < bestD) { best = r; bestD = d; }
    }
    if (!best) { rows.push({ words: [w], adjustedY: y }); continue; }
    best.words.push(w);
    best.adjustedY = best.words.reduce((s, c) => s + adj(c), 0) / best.words.length;
  }
  return rows
    .map((r) => ({ ...r, words: [...r.words].sort((a, b) => a.left - b.left) }))
    .sort((a, b) => a.adjustedY - b.adjustedY);
}

function cellIndex(word: OcrWord, bounds: number[]): number {
  const x = cx(word);
  for (let i = 0; i < bounds.length - 1; i += 1) if (x >= bounds[i]! && x < bounds[i + 1]!) return i;
  return bounds.length - 2;
}

function cells(row: WordRow, bounds: number[]): (i: number) => string {
  const map = new Map<number, string[]>();
  for (const w of row.words) {
    if (isNoise(w)) continue;
    const i = cellIndex(w, bounds);
    map.set(i, [...(map.get(i) ?? []), cleanCell(w.text)]);
  }
  return (i) => (map.get(i) ?? []).filter(Boolean).join(" ").trim();
}

/* ---------------------------- product code --------------------------- */

const TO_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", R: "1", T: "1", Z: "2", S: "5", G: "6", B: "8" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G" };

/**
 * Codes in this template are TWO LETTERS + TWO DIGITS (DI01), and the letters
 * are the first two letters of the product name (Diclofin -> DI). Tesseract
 * often mangles a short, boxed code ("DI01" -> "ploi"), so:
 *  1. repair letter/digit confusion by position;
 *  2. if the letters still disagree with the product name, use the name's
 *     letters and report it so the user can verify.
 */
function normalizeProductCode(raw: string, name: string, warnings: string[]): string | null {
  const code = cleanCell(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return null;
  if (code.length !== 4) return code;

  const chars = code.split("");
  for (let i = 0; i < 2; i += 1) if (/\d/.test(chars[i]!)) chars[i] = TO_LETTER[chars[i]!] ?? chars[i]!;
  for (let i = 2; i < 4; i += 1) if (/[A-Z]/.test(chars[i]!)) chars[i] = TO_DIGIT[chars[i]!] ?? chars[i]!;
  let fixed = chars.join("");

  const prefix = name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  if (prefix.length === 2 && /^[A-Z]{2}\d{2}$/.test(fixed) && fixed.slice(0, 2) !== prefix) {
    warnings.push(
      `Product code read as "${fixed}" but "${name}" normally starts with "${prefix}"; using "${prefix}${fixed.slice(2)}". Please verify.`,
    );
    fixed = prefix + fixed.slice(2);
  }
  return fixed;
}

/* ------------------------------- items ------------------------------- */

function isRealName(v: string): boolean {
  return (v.match(/[A-Za-z]/g) ?? []).length >= 3;
}

function parseItemRow(row: WordRow, bounds: number[], warnings: string[]): ExtractedInvoiceItem | null {
  const cell = cells(row, bounds);
  const productName = cell(0);
  let quantity = parseNumber(cell(6));
  let unitPrice = parseNumber(cell(7));
  let lineTotal = parseNumber(cell(8));

  if (!isRealName(productName)) return null;
  if (/^(itemdescription|description|subtotal|grandtotal)$/.test(compact(productName))) return null;
  if (quantity === null || unitPrice === null || lineTotal === null) return null;

  // quantity x unit price must equal the line total; repair a single misread.
  if (Math.abs(quantity * unitPrice - lineTotal) > 0.01) {
    const fixTotal = quantity * unitPrice;
    const fixQty = unitPrice ? lineTotal / unitPrice : NaN;
    const fixPrice = quantity ? lineTotal / quantity : NaN;
    if (looksLikeMisread(lineTotal, fixTotal)) {
      warnings.push(`"${productName}": line total ${lineTotal} corrected to ${fixTotal} (qty × price).`);
      lineTotal = fixTotal;
    } else if (Number.isFinite(fixQty) && looksLikeMisread(quantity, fixQty)) {
      warnings.push(`"${productName}": quantity ${quantity} corrected to ${fixQty} (total ÷ price).`);
      quantity = fixQty;
    } else if (Number.isFinite(fixPrice) && looksLikeMisread(unitPrice, fixPrice)) {
      warnings.push(`"${productName}": unit price ${unitPrice} corrected to ${fixPrice} (total ÷ qty).`);
      unitPrice = fixPrice;
    }
  }

  return {
    productName,
    productCode: normalizeProductCode(cell(1), productName, warnings),
    batchNumber: cleanCell(cell(2)).replace(/\s+/g, "") || null,
    expiryDate: parseSlashDate(cell(3)),
    unit: cleanCell(cell(5)).toUpperCase() || null,
    quantity,
    unitPrice,
    lineTotal,
  };
}

/* ------------------------------- totals ------------------------------ */

/**
 * Finds "<first> Total" (Sub Total / Grand Total) and the amount printed to its
 * right on the same slope-corrected line. Labels are matched loosely because
 * OCR garbles them ("Grand" -> "Gr@nd", "Total" -> "Tota1").
 */
function findAmount(
  words: OcrWord[], first: RegExp, slope: number, page: PageSize,
): number | null {
  const adj = (w: OcrWord) => cy(w) - cx(w) * slope;
  const tol = page.height * 0.02;

  // Only the totals block (lower half of the page), and only a label that is
  // really followed by "Total" on the same line - this rejects "Sub City".
  for (const label of words.filter((w) => first.test(compact(w.text)) && cy(w) > page.height * 0.5)) {
    const partner = words.find(
      (w) => /^tota[l1i]$/.test(compact(w.text)) && w.left > label.left && Math.abs(adj(w) - adj(label)) <= tol,
    );
    if (!partner && compact(label.text) !== "subtotal") continue;
    const labelRight = Math.max(label.right, partner?.right ?? 0);
    const value = words
      .filter((w) => w.left > labelRight && Math.abs(adj(w) - adj(label)) <= tol && isNumeric(w.text))
      .sort((a, b) => b.left - a.left)[0]; // right-most number = the amount column
    if (value) return parseNumber(value.text);
  }
  return null;
}

/* -------------------------------- main ------------------------------- */

const empty = (warning: string): ExtractedInvoice => ({
  source: "ocr", supplierName: null, supplierTin: null, invoiceNumber: null, invoiceDate: null,
  fsNumber: null, items: [], skippedLineCount: 0, warnings: [warning], subtotal: null,
  discount: null, tax: null, fees: null, grandTotal: null, paymentTerms: null,
});

export function extractDeviceTradingCreditSales(
  words: OcrWord[],
  confidence: number | null,
  pageOverride?: PageSize,
  traceId = "unknown",
): ExtractedInvoice {
  const startedAt = Date.now();
  logger.info({ traceId, stage: "template.extract.start", words: words.length, confidence }, "Device Trading template extraction started");
  if (!words || words.length === 0) return empty("OCR returned no words; invoice values could not be extracted.");

  const page = pageSize(words, pageOverride);
  const warnings: string[] = [];
  const bounds = TABLE_X.map((f) => f * page.width);

  const header = locateHeader(words, page);
  logger.info({ traceId, stage: "template.table.header", located: Boolean(header), slope: header?.slope, adjustedY: header?.adjustedY }, "Device Trading table header analysis completed");
  if (!header) warnings.push("Table header not located; using default geometry. Please review items.");
  const slope = header?.slope ?? FALLBACK_SLOPE;
  const adj = (w: OcrWord) => cy(w) - cx(w) * slope;

  // Body = below the header line, above the "Sub Total" line (slope-corrected).
  const subLabel = words.find((w) => /^sub(total)?$/.test(compact(w.text)) && cy(w) > page.height * 0.5);
  const bodyTop = (header?.adjustedY ?? page.height * 0.45) + page.height * 0.015;
  const bodyBottom = subLabel ? adj(subLabel) - page.height * 0.015 : page.height * 0.8;

  const tableWords = words.filter(
    (w) =>
      adj(w) > bodyTop && adj(w) < bodyBottom &&
      cx(w) >= bounds[0]! && cx(w) <= bounds[bounds.length - 1]!,
  );

  const rows = groupRows(tableWords.filter((w) => !isNoise(w)), slope, page.height * ROW_TOLERANCE);
  logger.info({ traceId, stage: "template.table.rows", tableWords: tableWords.length, rows: rows.length, bodyTop, bodyBottom }, "Device Trading table rows grouped");

  const items: ExtractedInvoiceItem[] = [];
  let skippedLineCount = 0;
  for (const row of rows) {
    const item = parseItemRow(row, bounds, warnings);
    if (item) { items.push(item); continue; }
    // Count only rows that carry amounts but no usable description
    // (stray scribbles / ghost rows); border junk is ignored silently.
    const c = cells(row, bounds);
    const numericCells = [c(6), c(7), c(8)].filter(isNumeric).length;
    if (numericCells >= 2) {
      skippedLineCount += 1;
      warnings.push(
        `A row with amounts (${[c(6), c(7), c(8)].filter(Boolean).join(" / ")}) but no readable item description was ignored.`,
      );
    }
  }

  // Totals
  const itemsSum = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  let subtotal = findAmount(words, /^sub(total)?$/, slope, page);
  let grandTotal = findAmount(words, /^gr[a-z@0]nd$/, slope, page);
  logger.info({ traceId, stage: "template.values", items: items.length, subtotal, grandTotal }, "Device Trading values extracted");

  if (subtotal !== null && items.length > 0 && Math.abs(itemsSum - subtotal) > 0.01) {
    if (looksLikeMisread(subtotal, itemsSum)) {
      warnings.push(`Subtotal read as ${subtotal}; corrected to ${itemsSum} (sum of line totals).`);
      subtotal = itemsSum;
    } else {
      warnings.push("Printed subtotal does not reconcile with extracted line totals.");
    }
  }
  if (subtotal === null && items.length > 0) subtotal = itemsSum;

  // "Non Tax (%)" is a rate, not an amount, so Grand Total = Sub Total here.
  if (grandTotal !== null && subtotal !== null && Math.abs(grandTotal - subtotal) > 0.01) {
    if (looksLikeMisread(grandTotal, subtotal)) {
      warnings.push(`Grand total read as ${grandTotal} (OCR digit confusion); using subtotal ${subtotal}.`);
      grandTotal = subtotal;
    } else {
      warnings.push("Printed grand total does not reconcile with the extracted subtotal.");
    }
  }
  if (grandTotal === null && subtotal !== null) {
    warnings.push("Grand total could not be read; using subtotal.");
    grandTotal = subtotal;
  }

  if (confidence !== null && confidence < 70) {
    warnings.push(`OCR confidence is low (${confidence.toFixed(1)}%). Please review the extracted values carefully.`);
  }

  const result: ExtractedInvoice = {
    source: "ocr",
    supplierName: extractSupplierName(words, page),
    supplierTin: null, // the only TIN on the page belongs to the customer
    invoiceNumber: extractInvoiceNumber(words),
    invoiceDate: extractInvoiceDate(words, page),
    fsNumber: extractFsNumber(words, page),
    items,
    skippedLineCount,
    warnings,
    subtotal,
    discount: null,
    tax: null,
    fees: null,
    grandTotal,
    paymentTerms: words.some((w) => /^credit$/i.test(cleanCell(w.text))) ? "CREDIT" : null,
  };
  logger.info({ traceId, stage: "template.extract.complete", items: result.items.length, subtotal: result.subtotal, grandTotal: result.grandTotal, warnings: result.warnings.length, durationMs: Date.now() - startedAt }, "Device Trading template extraction completed");
  return result;
}
