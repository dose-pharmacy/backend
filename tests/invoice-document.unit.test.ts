import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invoiceDocumentService,
  validateInvoiceFile,
  MAX_INVOICE_FILE_BYTES,
  type UploadedInvoiceFile,
} from "../src/services/purchasing/invoice-document.service.js";
import { toIsoInvoiceDate } from "../src/services/purchasing/invoice-extraction.service.js";

/**
 * The Tesseract binary is an external, machine-specific dependency, so the
 * image path is tested against a stubbed OCR engine: these are unit tests for
 * the pipeline, not for the OCR build.
 */
const ocrExtract = vi.hoisted(() => vi.fn());

vi.mock("../src/services/purchasing/invoice-ocr.service.js", () => ({
  invoiceOcrService: { extract: ocrExtract },
  parseTesseractTsv: vi.fn(),
}));

beforeEach(() => {
  ocrExtract.mockReset();
  ocrExtract.mockResolvedValue({ text: "", confidence: null });
});

const fixture = (name: string) => join(dirname(fileURLToPath(import.meta.url)), "fixtures", name);

function file(
  name: string,
  mimeType: string,
  overrides: Partial<UploadedInvoiceFile> = {},
): UploadedInvoiceFile {
  const buffer = readFileSync(fixture(name));
  return {
    originalName: name,
    mimeType,
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

/**
 * Unit tests for the uploaded-document extraction pipeline (pure
 * transformation: no database, no persistence). The extraction output is a
 * review-only proposal; the invoice-upload preview/confirm endpoints
 * re-validate everything against the live database.
 */
describe("invoice document extraction (uploaded file)", () => {
  it("extracts a text-layer PDF invoice (header, TIN, FS number, line item, US expiry date)", async () => {
    const result = await invoiceDocumentService.extractFromFile(
      file("invoice.pdf", "application/pdf"),
    );

    expect(result.document.kind).toBe("pdf");
    expect(result.document.textExtracted).toBe(true);

    expect(result.invoiceNumber).toBe("CR-00004212");
    expect(result.supplierName).toBe("DEVICE TRADING PLC");
    expect(result.supplierTin).toBe("0046966869");
    expect(result.fsNumber).toBe("00012242");
    // "Aug 20,2026 12:18" normalized to an ISO timestamp.
    expect(result.invoiceDate).toBe("2026-08-20T00:00:00.000Z");

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.productCode).toBe("FINS-01");
    expect(item.productName).toContain("FINALERGE");
    expect(item.quantity).toBe(12);
    expect(item.unitPrice).toBe(427.5);
    expect(item.lineTotal).toBe(5130);
    // US MM/DD/YYYY expiry (30 cannot be a month) normalized correctly.
    expect(item.expiryDate).toBe("2030-06-30T00:00:00.000Z");

    expect(result.subtotal).toBe(5130);
    expect(result.grandTotal).toBe(5130);
  });

  it("validates a JPEG upload and reports that OCR review is required", async () => {
    const result = await invoiceDocumentService.extractFromFile(
      file("sample.jpg", "image/jpeg"),
    );

    expect(result.source).toBe("ocr");
    expect(result.document.kind).toBe("jpeg");
    expect(result.document.extractionMethod).toBe("ocr");
    expect(result.document.textExtracted).toBe(false);
    expect(result.warnings.join(" ")).toContain("no readable text");
    expect(result.items).toHaveLength(0);
    expect(result.supplierName).toBeNull();
  });

  it("extracts a photographed invoice through the OCR path", async () => {
    // Exactly what a photo of the attached DEVICE TRADING PLC invoice produces:
    // OCR text with rows and column gaps preserved.
    ocrExtract.mockResolvedValue({
      text: [
        "DEVICE TRADING\tPLC",
        "TIN: 0046966889",
        "CREDIT Sales Attachment",
        "Date: Aug 20 2026 12:16\tFs No. : 00012242\tInvoice No. : CR-00004217",
        "Customer Name :\tDOSE PHARMACY\tTIN : 0042716050",
        "Item Description\tCode\tBatch #\tExpr. Date\tMfg. Date\tUOM\tQuantity\tUnit Price\tTotal Price",
        "Diclofin\tDI01\t3260068\t06/30/27\t\tPK\t5.00\t700.00\t3500.00",
        "Sub Total\t3500.00",
        "Non Tax (%)\t5.00",
        "Grand Total\t3500.00",
      ].join("\n"),
      confidence: 62.07,
    });

    const result = await invoiceDocumentService.extractFromFile(
      file("sample.jpg", "image/jpeg"),
    );

    expect(result.source).toBe("ocr");
    expect(result.document.textExtracted).toBe(true);
    expect(result.document.ocrConfidence).toBeCloseTo(62.07);

    expect(result.supplierName).toBe("DEVICE TRADING PLC");
    expect(result.supplierTin).toBe("0046966889");
    expect(result.invoiceNumber).toBe("CR-00004217");
    expect(result.fsNumber).toBe("00012242");
    expect(result.invoiceDate).toBe("2026-08-20T00:00:00.000Z");
    expect(result.subtotal).toBe(3500);
    expect(result.tax).toBe(5);
    expect(result.grandTotal).toBe(3500);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      productCode: "DI01",
      productName: "Diclofin",
      quantity: 5,
      unit: "PK",
      unitPrice: 700,
      lineTotal: 3500,
      batchNumber: "3260068",
      expiryDate: "2027-06-30T00:00:00.000Z",
    });

    expect(result.warnings.join(" ")).not.toContain("No line items");
    expect(result.warnings.join(" ")).not.toContain("Invoice number was not found");
    expect(result.warnings.join(" ")).not.toContain("confidence is low");
  });

  it("validates a PNG upload via magic bytes", async () => {
    const result = await invoiceDocumentService.extractFromFile(
      file("sample.png", "image/png"),
    );
    expect(result.document.kind).toBe("png");
    expect(result.document.sizeBytes).toBeGreaterThan(0);
  });

  it("validates a WEBP upload via magic bytes", async () => {
    const result = await invoiceDocumentService.extractFromFile(
      file("sample.webp", "image/webp"),
    );
    expect(result.document.kind).toBe("webp");
  });

  it("rejects an unsupported file type even with a spoofed PDF filename", async () => {
    // GIF magic bytes with a .pdf name.
    const gif = Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.alloc(64, 0x00),
    ]);
    const bogus: UploadedInvoiceFile = {
      originalName: "invoice.pdf",
      mimeType: "application/pdf",
      size: gif.length,
      buffer: gif,
    };
    expect(() => validateInvoiceFile(bogus)).toMatchObject({});
    await expect(invoiceDocumentService.extractFromFile(bogus)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("rejects a declared type that contradicts the actual content", async () => {
    // Real PNG bytes declared as application/pdf with a .pdf extension.
    await expect(
      invoiceDocumentService.extractFromFile(file("sample.png", "application/pdf")),
    ).rejects.toMatchObject({ statusCode: 415 });
  });

  it("rejects an oversized file", async () => {
    const big = Buffer.alloc(MAX_INVOICE_FILE_BYTES + 1, 0x25); // '%PDF-' padding
    await expect(
      invoiceDocumentService.extractFromFile({
        originalName: "invoice.pdf",
        mimeType: "application/pdf",
        size: big.length,
        buffer: big,
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("rejects an empty file", async () => {
    await expect(
      invoiceDocumentService.extractFromFile({
        originalName: "invoice.pdf",
        mimeType: "application/pdf",
        size: 0,
        buffer: Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a corrupted PDF with a clean 422 (no crash)", async () => {
    await expect(
      invoiceDocumentService.extractFromFile(file("corrupted.pdf", "application/pdf")),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("tolerates a missing optional field without failing the extraction", async () => {
    // invoice.pdf has TIN/FS; images simply return nulls instead of throwing.
    const result = await invoiceDocumentService.extractFromFile(
      file("sample.jpg", "image/jpeg"),
    );
    expect(result.supplierTin).toBeNull();
    expect(result.fsNumber).toBeNull();
    expect(result.invoiceNumber).toBeNull();
  });
});

describe("invoice date normalization", () => {
  it.each([
    ["Aug 20,2026 12:18", "2026-08-20"],
    ["August 20, 2026", "2026-08-20"],
    ["20/08/2026", "2026-08-20"],
    ["20-08-2026", "2026-08-20"],
    ["20.08.2026", "2026-08-20"],
    ["06/30/2030", "2030-06-30"],
    ["12/31/2031", "2031-12-31"],
    ["2030-06-30", "2030-06-30"],
    ["2030-06-30T00:00:00.000Z", "2030-06-30"],
  ])("normalizes %s to %s", (input, expectedDay) => {
    expect(toIsoInvoiceDate(input)?.slice(0, 10)).toBe(expectedDay);
  });

  it("returns null for unparseable dates", () => {
    expect(toIsoInvoiceDate("not a date")).toBeNull();
    expect(toIsoInvoiceDate("")).toBeNull();
  });
});
