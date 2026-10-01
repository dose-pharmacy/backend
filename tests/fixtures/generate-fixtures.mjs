// One-off generator for binary test fixtures (run: node tests/fixtures/generate-fixtures.mjs)
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

// ── PNG: minimal valid 1x1 image ────────────────────────────────────────────
const crc32 = (buf) => {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.from([0, 0, 0]))),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(join(here, "sample.png"), png);

// ── JPEG: SOI + minimal JFIF APP0 + EOI (structure, not a decodable photo) ──
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  Buffer.alloc(32, 0x00),
  Buffer.from([0xff, 0xd9]),
]);
writeFileSync(join(here, "sample.jpg"), jpeg);

// ── WEBP: RIFF....WEBP container header ─────────────────────────────────────
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(24, 0x00),
]);
writeFileSync(join(here, "sample.webp"), webp);

// ── Corrupted PDF: valid magic, garbage body ────────────────────────────────
writeFileSync(
  join(here, "corrupted.pdf"),
  Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("this is not a real pdf body at all")]),
);

// ── Text-layer PDF styled like the sample supplier invoice ──────────────────
const pdfText = [
  "Invoice No: CR-00004212",
  "Date: Aug 20,2026 12:18",
  "TIN: 0046966869",
  "FS No: 00012242",
  "Supplier: DEVICE TRADING PLC",
  "FINS-01  FINALERGE 1MG/ML SOLUTION 100ML  12  x  427.50  5130.00  EXP:06/30/2030",
  "Subtotal: 5130.00",
  "Grand Total: 5130.00",
].join("\n");
const esc = pdfText.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const stream = `BT /F1 10 Tf 40 750 Td (${esc.split("\n").join(") Tj\n0 -14 Td (")}) Tj ET`;
const pdf = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
  `4 0 obj<</Length ${stream.length}>>stream`,
  stream,
  "endstream",
  "endobj",
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  "trailer<</Root 1 0 R>>",
].join("\n");
writeFileSync(join(here, "invoice.pdf"), pdf, "latin1");

console.log("fixtures written to", here);
