import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { logger } from "../../config/logger.js";

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
  /** Size of the image Tesseract actually saw (after preprocessing). Word boxes are in this coordinate space. */
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
const DEFAULT_TESSERACT_TIMEOUT_MS = 60_000;
const DEFAULT_TESSERACT_TARGET_WIDTH = 1800;

export type ConcurrencyLimiter = <T>(task: () => Promise<T>) => Promise<T>;

function resolveTargetWidth(): number {
  const raw = Number(process.env.TESSERACT_TARGET_WIDTH ?? DEFAULT_TESSERACT_TARGET_WIDTH);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TESSERACT_TARGET_WIDTH;
}

function resolvePsm(): number {
  const raw = Number(process.env.TESSERACT_PSM ?? 6);
  return Number.isFinite(raw) ? raw : 6;
}

function resolveTesseractTimeoutMs(): number {
  const raw = Number(process.env.TESSERACT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TESSERACT_TIMEOUT_MS;
}

/**
 * A tiny FIFO semaphore. Caps how many Tesseract processes a single Node
 * process may run at once.
 *
 * Without this, two concurrent uploads spawned two Tesseract processes at the
 * same time (visible in production logs), which on a CPU-limited instance
 * starves both. An in-memory limiter only bounds concurrency WITHIN one Node
 * process — if the service runs several instances, each gets its own budget.
 *
 * Exported for tests.
 */
export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  const queue: (() => void)[] = [];
  let active = 0;

  const pump = (): void => {
    while (active < max && queue.length > 0) {
      active += 1;
      queue.shift()!();
    }
  };

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        let result: Promise<T>;
        try {
          result = task();
        } catch (error) {
          active -= 1;
          pump();
          reject(error);
          return;
        }
        result.then(resolve, reject).finally(() => {
          active -= 1;
          pump();
        });
      });
      pump();
    });
  };
}

function resolveOcrConcurrency(): number {
  const raw = Number(process.env.OCR_MAX_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

let tesseractLimiter: ConcurrencyLimiter | null = null;

function getTesseractLimiter(): ConcurrencyLimiter {
  if (!tesseractLimiter) {
    tesseractLimiter = createConcurrencyLimiter(resolveOcrConcurrency());
  }
  return tesseractLimiter;
}

/**
 * Normalizes a photo before OCR: auto-rotate, grayscale, contrast, slight
 * sharpening, then a clean PNG.
 *
 * The image is never enlarged. `TESSERACT_TARGET_WIDTH` is an upper bound
 * only — a 1024px-wide photo stays 1024px. Enlarging it to 1800px (the
 * previous behaviour) tripled the pixel count for no recognition gain and
 * dominated preprocessing time (6–15s observed in production).
 *
 * Exported for tests.
 */
export async function preprocessImage(buffer: Buffer, traceId: string): Promise<Buffer> {
  const startedAt = Date.now();
  logger.info({ traceId, stage: "ocr.preprocess.start", inputBytes: buffer.length }, "Invoice OCR preprocessing started");
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
    logger.warn({ traceId, stage: "ocr.preprocess.reject", width, height, pixels: width * height }, "Invoice OCR image exceeds pixel limit");
    throw new AppError(
      413,
      ErrorCode.VALIDATION_ERROR,
      "Invoice image dimensions exceed the OCR processing limit",
    );
  }
  const targetWidth = resolveTargetWidth();

  const working =
    width > 0
      ? source.resize({
          width: targetWidth,
          kernel: "lanczos3",
          withoutEnlargement: true,
        })
      : source;

  const processed = await working
    // Convert to grayscale.
    .grayscale()
    // Improve contrast.
    .normalize()
    // Slight sharpening helps printed characters.
    .sharpen()
    // Give OCR a clean PNG.
    .png()
    .toBuffer();
  logger.info({ traceId, stage: "ocr.preprocess.complete", inputWidth: width, inputHeight: height, outputBytes: processed.length, durationMs: Date.now() - startedAt }, "Invoice OCR preprocessing completed");
  return processed;
}

/** Optional command override so tests can drive the real spawn/timeout/kill
 * lifecycle without a Tesseract binary; production always uses the default. */
export type TesseractInvocation = { command: string; args: string[] };

/**
 * Runs Tesseract over one image and resolves with its parsed TSV.
 *
 * Exported for tests. The child process is pinned to a single OpenMP thread:
 * Tesseract is OpenMP-parallel, and on a CPU-limited container the default
 * thread pool oversubscribes the cgroup, which produces the production
 * symptom of a process that writes its TSV header and then appears to hang.
 */
export function runTesseract(
  imageBuffer: Buffer,
  psm: number,
  traceId: string,
  invocation?: TesseractInvocation,
): Promise<OcrResult> {
  return new Promise((resolve, reject) => {
    const language = process.env.TESSERACT_LANG || "eng";
    const tessdataPrefix = process.env.TESSDATA_PREFIX || "/usr/share/tessdata";
    const command = invocation?.command ?? (process.env.TESSERACT_PATH || "tesseract");
    const args =
      invocation?.args ??
      ["stdin", "stdout", "--psm", String(psm), "-l", language, "tsv"];
    const timeoutMs = resolveTesseractTimeoutMs();
    const startedAt = Date.now();

    logger.info({ traceId, stage: "ocr.tesseract.start", tesseractPath: command, psm, language, tessdataPrefix, timeoutMs, inputBytes: imageBuffer.length }, "Invoice Tesseract process starting");

    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      env: {
        ...process.env,
        // Pass the data directory explicitly instead of relying on the
        // ambient environment being inherited correctly.
        TESSDATA_PREFIX: tessdataPrefix,
        OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT ?? "1",
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    // Exactly one of resolve/reject wins, and the timer is always cleared.
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      const durationMs = Date.now() - startedAt;
      logger.error({ traceId, stage: "ocr.tesseract.timeout", timeoutMs, durationMs }, "Invoice Tesseract process timed out");
      // Settle first, then SIGKILL so the hung process is always reaped.
      settle(() =>
        reject(
          new AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "Invoice OCR timed out",
          ),
        ),
      );
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(Buffer.from(chunk));
    });

    child.on("error", (error: Error) => {
      logger.error({ traceId, stage: "ocr.tesseract.error", err: error, durationMs: Date.now() - startedAt }, "Invoice Tesseract process error");
      settle(() =>
        reject(
          new AppError(
            500,
            ErrorCode.INTERNAL_ERROR,
            `OCR engine could not be started: ${error.message}`,
          ),
        ),
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const durationMs = Date.now() - startedAt;
      const stdoutBytes = Buffer.concat(stdout).length;
      const stderrBytes = Buffer.concat(stderr).length;
      // Always log the close, even when the timeout already settled, so a
      // timeout followed by close is fully visible in production.
      logger.info({ traceId, stage: "ocr.tesseract.close", code, signal, durationMs, stdoutBytes, stderrBytes }, "Invoice Tesseract process closed");

      settle(() => {
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
        const result = parseTesseractTsv(tsv);
        logger.info({ traceId, stage: "ocr.tsv.parsed", words: result.words.length, confidence: result.confidence }, "Invoice OCR TSV parsed");
        resolve(result);
      });
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
  async extract(buffer: Buffer, traceId = randomUUID()): Promise<OcrResult> {
    const startedAt = Date.now();
    logger.info({ traceId, stage: "ocr.extract.start", inputBytes: buffer.length }, "Invoice OCR extraction started");
    const processed = await preprocessImage(buffer, traceId);

    const psm = resolvePsm();

    const [result, meta] = await Promise.all([
      getTesseractLimiter()(() => runTesseract(processed, psm, traceId)),
      sharp(processed).metadata(),
    ]);

    logger.info({ traceId, stage: "ocr.extract.complete", words: result.words.length, confidence: result.confidence, width: meta.width, height: meta.height, processedBytes: processed.length, durationMs: Date.now() - startedAt }, "Invoice OCR extraction completed");
    return { ...result, width: meta.width, height: meta.height };
  },
};
