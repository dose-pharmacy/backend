import { describe, expect, it } from "vitest";
import { invoiceExtractionService } from "../src/services/purchasing/invoice-extraction.service.js";

/**
 * Unit tests for supplier invoice document extraction (pure transformation:
 * no database). The extraction output is a review-only proposal; the
 * invoice-upload preview/confirm endpoints re-validate everything.
 */
describe("invoice document extraction", () => {
  it("parses a text invoice: header fields, line items, totals and warnings", async () => {
    const result = await invoiceExtractionService.extract({
      text: [
        "Supplier: MedSupply Ltd",
        "Invoice No: INV-2026-0421",
        "Date: 15/03/2026",
        "",
        "AMOX-500    Amoxicillin 500mg caps    80    x    10.00    800.00",
        "PARA-25     Paracetamol 25mg sachets   30    x     2.50     75.00",
        "Subtotal: 875.00",
        "VAT: 87.50",
        "Grand Total: 962.50",
      ].join("\n"),
    });

    expect(result.source).toBe("text");
    expect(result.invoiceNumber).toBe("INV-2026-0421");
    expect(result.invoiceDate).not.toBeNull();
    expect(result.supplierName).toBe("MedSupply Ltd");
    expect(result.subtotal).toBe(875);
    expect(result.tax).toBe(87.5);
    expect(result.grandTotal).toBe(962.5);

    expect(result.items).toHaveLength(2);
    const [amox, para] = result.items;
    expect(amox!.productCode).toBe("AMOX-500");
    expect(amox!.productName).toBe("Amoxicillin 500mg caps");
    expect(amox!.quantity).toBe(80);
    expect(amox!.unitPrice).toBe(10);
    expect(amox!.lineTotal).toBe(800);
    expect(para!.productCode).toBe("PARA-25");
    expect(para!.quantity).toBe(30);
    expect(para!.lineTotal).toBe(75);

    // Header/total lines are consumed by the header parser, not skipped.
    expect(result.skippedLineCount).toBeLessThanOrEqual(1);
  });

  it("extracts batch numbers and expiry dates from line text", async () => {
    const result = await invoiceExtractionService.extract({
      lines: ["AMOX-500  Amoxicillin 500mg  60  x  10.00  600.00  EXP:2032-06-30"],
    });
    // No batch printed on this line -> null (user supplies it during review).
    expect(result.items[0]!.batchNumber).toBeNull();
    expect(result.items[0]!.expiryDate).toBe("2032-06-30T00:00:00.000Z");
  });

  it("normalizes pre-structured OCR adapter lines and reports problems", async () => {
    const result = await invoiceExtractionService.extract({
      document: {
        supplierName: "MedSupply Ltd",
        invoiceNumber: "INV-77",
        items: [
          { productCode: "AMOX-500", productName: "Amoxicillin 500mg", quantity: 40, unitPrice: 10 },
          { productName: null, quantity: 0 },
          { productName: "Vitamin C", quantity: 5, expiryDate: "31/12/2030" },
        ],
        grandTotal: 450,
        paymentTerms: "CREDIT",
      },
    });

    expect(result.source).toBe("document");
    expect(result.items).toHaveLength(3);
    expect(result.items[0]!.quantity).toBe(40);
    // dd/mm/yyyy normalized to ISO for review (parsed in local time).
    expect(result.items[2]!.expiryDate).toContain("2030-12-3");
    expect(result.warnings.join(" ")).toContain("Line 2");
    expect(result.paymentTerms).toBe("CREDIT");
  });

  it("reports an unparseable document instead of throwing", async () => {
    const result = await invoiceExtractionService.extract({ text: "hello world\nnothing here" });
    expect(result.items).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("No line items");
    expect(result.warnings.join(" ")).toContain("Invoice number was not found");
  });

  it("rejects an empty request", async () => {
    await expect(invoiceExtractionService.extract({})).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});
