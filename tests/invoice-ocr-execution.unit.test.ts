import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConcurrencyLimiter,
  preprocessImage,
  runTesseract,
} from "../src/services/purchasing/invoice-ocr.service.js";

/**
 * Execution-level tests for the invoice OCR engine.
 *
 * These drive the real spawn/timeout/kill lifecycle (using `node -e` as a
 * stand-in binary) and the real sharp preprocessing, so they cover exactly the
 * stages that broke in production:
 *
 *   - preprocessing must never enlarge a small photo
 *   - a hung Tesseract process must be killed and reject exactly once
 *   - child environment (TESSDATA_PREFIX, single-thread OMP) must be explicit
 *   - concurrent OCR requests must not spawn unlimited Tesseract processes
 *
 * They do NOT require a Tesseract install; the container-level verification is
 * documented in the Dockerfile (build-time assertions).
 */

const TSV_HEADER =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

const TSV_ONE_WORD = [
  TSV_HEADER,
  "5\t1\t1\t1\t1\t1\t10\t20\t30\t20\t91\tHELLO",
].join("\n");

const ENV_KEYS = [
  "TESSERACT_TARGET_WIDTH",
  "TESSERACT_TIMEOUT_MS",
  "TESSDATA_PREFIX",
] as const;

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv.has(key)) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      savedEnv.delete(key);
    }
  }
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

/** A non-uniform grayscale image (a flat one would make `normalize()` useless). */
async function grayGradient(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = 200 + Math.round((55 * x) / width);
      const index = (y * width + x) * 3;
      raw[index] = value;
      raw[index + 1] = value;
      raw[index + 2] = value;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

const node = { command: process.execPath };

describe("invoice OCR preprocessing", () => {
  it("does not enlarge an image that is already at or below the target width", async () => {
    setEnv("TESSERACT_TARGET_WIDTH", "1800");

    const output = await preprocessImage(await grayGradient(1024, 768), "t-small");
    const meta = await sharp(output).metadata();

    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(768);
  });

  it("caps an oversized image at the target width", async () => {
    setEnv("TESSERACT_TARGET_WIDTH", "1800");

    const output = await preprocessImage(await grayGradient(3000, 2000), "t-large");
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(1800);
    expect(meta.height).toBe(1200);
  });
});

describe("invoice OCR concurrency limiter", () => {
  it("caps simultaneous tasks at the configured limit", async () => {
    const limit = createConcurrencyLimiter(3);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return index;
        }),
      ),
    );

    expect(maxActive).toBe(3);
  });

  it("runs queued tasks in FIFO order", async () => {
    const limit = createConcurrencyLimiter(1);
    const started: number[] = [];
    const release: (() => void)[] = [];

    const pending = [0, 1, 2].map((n) =>
      limit(
        () =>
          new Promise<number>((resolve) => {
            started.push(n);
            release.push(() => resolve(n));
          }),
      ),
    );

    expect(started).toEqual([0]);

    release[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);

    release[1]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);

    release[2]!();
    expect(await Promise.all(pending)).toEqual([0, 1, 2]);
  });

  it("treats a non-positive limit as a single slot", async () => {
    const limit = createConcurrencyLimiter(0);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      [0, 1, 2].map((n) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return n;
        }),
      ),
    );

    expect(maxActive).toBe(1);
  });
});

describe("invoice OCR tesseract process lifecycle", () => {
  it("resolves with parsed TSV on a clean exit", async () => {
    const script = `let b=[];process.stdin.on('data',c=>b.push(c));process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(TSV_ONE_WORD)});process.exit(0);});`;

    const result = await runTesseract(Buffer.from("image"), 6, "t-ok", {
      ...node,
      args: ["-e", script],
    });

    expect(result.text).toBe("HELLO");
    expect(result.words).toHaveLength(1);
    expect(result.words[0]!.text).toBe("HELLO");
    expect(result.confidence).toBe(91);
  });

  it("resolves an empty TSV to an empty result", async () => {
    const script = `process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;

    const result = await runTesseract(Buffer.from("image"), 6, "t-empty", {
      ...node,
      args: ["-e", script],
    });

    expect(result.text).toBe("");
    expect(result.words).toEqual([]);
    expect(result.confidence).toBeNull();
  });

  it("rejects with the stderr message when tesseract exits non-zero", async () => {
    const script = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('boom');process.exit(2);});`;

    await expect(
      runTesseract(Buffer.from("image"), 6, "t-fail", {
        ...node,
        args: ["-e", script],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "Invoice OCR failed: boom",
    });
  });

  it("kills a hung tesseract and rejects once with the timeout error", async () => {
    setEnv("TESSERACT_TIMEOUT_MS", "150");

    const script = `process.stdin.resume();process.stdout.write('header\\n');setInterval(()=>{},1000);`;
    const startedAt = Date.now();

    let rejections = 0;
    const attempt = runTesseract(Buffer.from("image"), 6, "t-timeout", {
      ...node,
      args: ["-e", script],
    }).catch((error: unknown) => {
      rejections += 1;
      throw error;
    });

    await expect(attempt).rejects.toMatchObject({
      statusCode: 422,
      message: "Invoice OCR timed out",
    });

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(5000);

    // Give a delayed `close` handler a moment; a double settle would bump this.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rejections).toBe(1);
  });

  it("rejects with a start error when the binary is missing", async () => {
    await expect(
      runTesseract(Buffer.from("image"), 6, "t-missing", {
        command: "definitely-not-a-real-ocr-binary-xyz",
        args: [],
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("passes TESSDATA_PREFIX and a single-thread OMP limit to the child", async () => {
    setEnv("TESSDATA_PREFIX", "/custom/tessdata");

    const script = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write([process.env.TESSDATA_PREFIX,process.env.OMP_THREAD_LIMIT].join('|'));process.exit(3);});`;

    try {
      await runTesseract(Buffer.from("image"), 6, "t-env", {
        ...node,
        args: ["-e", script],
      });
      throw new Error("expected runTesseract to reject");
    } catch (error) {
      expect((error as Error).message).toBe(
        "Invoice OCR failed: /custom/tessdata|1",
      );
    }
  });
});
