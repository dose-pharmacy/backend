import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import sharp from "sharp";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";

export type OcrWord = {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  page: number;
  block: number;
  paragraph: number;
  line: number;
  word: number;
};

export type OcrResult = {
  /**
   * Recognized document text.
   *
   * IMPORTANT: this keeps the document's LINE structure (\n) and its COLUMN
   * structure (cell separators become tabs / runs of spaces). Flattening the
   * page into a single line makes it impossible for the extraction layer to
   * tell a header field from a table row, so that never happens here.
   */
  text: string;
  words: OcrWord[];
  confidence: number | null;
  /** Size of the image Tesseract actually saw (after upscaling). Word boxes are in this coordinate space. */
  width?: number;
  height?: number;
};

/** Tesseract TSV word row (level 5) with its layout box. */
type TsvWord = {
  page: number;
  block: number;
  par: number;
  line: number;
  word: number;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  text: string;
};

const TSV_WORD_LEVEL = 5;
const TSV_MIN_COLUMNS = 12;
const MAX_OCR_PIXELS = 40_000_000;

/**
 * Upscales small photos and cleans them up before OCR. Phone snapshots of
 * printed invoices are typically 1–2k pixels wide with uneven lighting, which
 * Tesseract handles noticeably worse than a normalized, upscaled grayscale.
 */
async function preprocessImage(buffer: Buffer): Promise<Buffer> {
  const source = sharp(buffer).rotate();

  let width = 0;
  let height = 0;
  try {
    const metadata = await source.metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
  } catch {
    width = 0;
    height = 0;
  }
  if (width > 0 && height > 0 && width * height > MAX_OCR_PIXELS) {
    throw new AppError(
      413,
      ErrorCode.VALIDATION_ERROR,
      "Invoice image dimensions exceed the OCR processing limit",
    );
  }
  const targetWidth = Number(process.env.TESSERACT_TARGET_WIDTH ?? 1800);

  const working =
    width > 0 && width < targetWidth
      ? source.resize({ width: targetWidth, kernel: "lanczos3" })
      : source;

  return working
    // Convert to grayscale.
    .grayscale()
    // Improve contrast.
    .normalize()
    // Slight sharpening helps printed characters.
    .sharpen()
    // Give OCR a clean PNG.
    .png()
    .toBuffer();
}

function runTesseract(imageBuffer: Buffer, psm: number): Promise<OcrResult> {
  return new Promise((resolve, reject) => {
    const tesseractPath = process.env.TESSERACT_PATH || "tesseract";

    const child: ChildProcessWithoutNullStreams = spawn(tesseractPath, [
      "stdin",
      "stdout",
      "--psm",
      String(psm),
      "-l",
      "eng",
      "tsv",
    ]);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutMs = Number(process.env.TESSERACT_TIMEOUT_MS ?? 30_000);
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new AppError(
          422,
          ErrorCode.VALIDATION_ERROR,
          "Invoice OCR timed out",
        ),
      );
    }, Number.isFinite(timeoutMs) ? timeoutMs : 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(Buffer.from(chunk));
    });

    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      reject(
        new AppError(
          500,
          ErrorCode.INTERNAL_ERROR,
          `OCR engine could not be started: ${error.message}`,
        ),
      );
    });

    child.on("close", (code: number) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const errorMessage = Buffer.concat(stderr).toString("utf8").trim();

        reject(
          new AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            `Invoice OCR failed${errorMessage ? `: ${errorMessage}` : ""}`,
          ),
        );

        return;
      }

      const tsv = Buffer.concat(stdout).toString("utf8");

      resolve(parseTesseractTsv(tsv));
    });

    child.stdin.on("error", () => {
      // The process may close stdin while exiting.
    });

    child.stdin.end(imageBuffer);
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function parseTsvWords(tsv: string): TsvWord[] {
  const words: TsvWord[] = [];

  for (const rawLine of tsv.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    const columns = rawLine.split("\t");

    // Tesseract TSV has:
    // level,page_num,block_num,par_num,line_num,word_num,
    // left,top,width,height,conf,text
    if (columns.length < TSV_MIN_COLUMNS) continue;
    if (Number(columns[0]) !== TSV_WORD_LEVEL) continue;

    const text = columns.slice(11).join("\t").trim();
    if (!text) continue;

    const confidence = Number(columns[10]);

    words.push({
      page: Number(columns[1]) || 1,
      block: Number(columns[2]) || 0,
      par: Number(columns[3]) || 0,
      line: Number(columns[4]) || 0,
      word: Number(columns[5]) || 0,
      left: Number(columns[6]) || 0,
      top: Number(columns[7]) || 0,
      width: Number(columns[8]) || 0,
      height: Number(columns[9]) || 0,
      confidence: Number.isFinite(confidence) ? confidence : -1,
      text,
    });
  }

  return words;
}

type RowSeed = {
  words: TsvWord[];
  top: number;
  bottom: number;
};

function rowBand(words: TsvWord[]): { top: number; bottom: number } {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const word of words) {
    top = Math.min(top, word.top);
    bottom = Math.max(bottom, word.top + Math.max(word.height, 1));
  }

  return { top, bottom };
}

/**
 * Two of Tesseract's "lines" belong to the same printed row when their
 * vertical boxes actually overlap. Two *different* printed rows never overlap,
 * so this can only join pieces of one row (a table row whose columns were
 * emitted as separate lines, or a skewed row split in half).
 */
function shouldMergeRows(current: RowSeed, seed: RowSeed): boolean {
  const overlap =
    Math.min(current.bottom, seed.bottom) - Math.max(current.top, seed.top);
  const seedHeight = Math.max(seed.bottom - seed.top, 1);

  return overlap >= seedHeight * 0.5;
}

/**
 * Groups words into VISUAL rows. Tesseract's own line segmentation is only the
 * starting point: on forms and tables it happily emits each column as its own
 * line, which would destroy every row if used as-is.
 */
function groupWordsIntoRows(words: TsvWord[]): TsvWord[][] {
  const seeds = new Map<string, TsvWord[]>();

  for (const word of words) {
    const key = `${word.page}:${word.block}:${word.par}:${word.line}`;

    const bucket = seeds.get(key);

    if (bucket) bucket.push(word);
    else seeds.set(key, [word]);
  }

  const ordered: RowSeed[] = [...seeds.values()]
    .map((groupWords) => ({ words: groupWords, ...rowBand(groupWords) }))
    .sort((a, b) => a.top - b.top);

  const rows: RowSeed[] = [];

  for (const seed of ordered) {
    const current = rows[rows.length - 1];

    if (current && shouldMergeRows(current, seed)) {
      current.words.push(...seed.words);
      current.top = Math.min(current.top, seed.top);
      current.bottom = Math.max(current.bottom, seed.bottom);
    } else {
      rows.push({ words: [...seed.words], top: seed.top, bottom: seed.bottom });
    }
  }

  return rows.map((row) => row.words);
}

/**
 * Renders one visual row. Gaps wider than roughly two characters are treated
 * as cell boundaries and become tabs, so the extraction layer can still split
 * "Diclofin" from "DI01", "5.00" and "3500.00".
 */
function buildRowText(words: TsvWord[]): string {
  const sorted = [...words].sort((a, b) => a.left - b.left || a.word - b.word);

  const characterWidths = sorted
    .filter((word) => word.width > 0 && word.text.length > 0)
    .map((word) => word.width / word.text.length);

  const characterWidth = median(characterWidths);
  const columnGap = Math.max(characterWidth * 2.2, 8);

  let row = "";

  for (let index = 0; index < sorted.length; index += 1) {
    const word = sorted[index]!;

    if (index > 0) {
      const previous = sorted[index - 1]!;
      const gap = word.left - (previous.left + previous.width);

      row += gap >= columnGap ? "\t" : " ";
    }

    row += word.text;
  }

  return row.trim();
}

/**
 * Parses Tesseract's TSV output into line-structured text.
 *
 * Exported for tests: the geometry/layout reconstruction is the part that
 * decides whether the downstream invoice parser can see rows and columns at
 * all, so it is verified directly against synthetic word boxes.
 */
export function parseTesseractTsv(tsv: string): OcrResult {
  const words = parseTsvWords(tsv);

  const confidences = words
    .map((word) => word.confidence)
    .filter((confidence) => Number.isFinite(confidence) && confidence >= 0);

  const averageConfidence =
    confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null;

  const lines = groupWordsIntoRows(words)
    .map(buildRowText)
    .filter((line) => line.length > 0);

  return {
    text: lines.join("\n"),
    words: words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      left: word.left,
      top: word.top,
      width: word.width,
      height: word.height,
      right: word.left + word.width,
      bottom: word.top + word.height,
      page: word.page,
      block: word.block,
      paragraph: word.par,
      line: word.line,
      word: word.word,
    })),
    confidence: averageConfidence,
  };
}

export const invoiceOcrService = {
  async extract(buffer: Buffer): Promise<OcrResult> {
    const processed = await preprocessImage(buffer);

    const psm = Number(process.env.TESSERACT_PSM ?? 6);

    const [result, meta] = await Promise.all([
      runTesseract(processed, Number.isFinite(psm) ? psm : 6),
      sharp(processed).metadata(),
    ]);

    return { ...result, width: meta.width, height: meta.height };
  },
};
