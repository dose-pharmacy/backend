import { describe, expect, it } from "vitest";
import { parseTesseractTsv } from "../src/services/purchasing/invoice-ocr.service.js";
import { extractDeviceTradingCreditSales, isDeviceTradingCreditSalesTemplate } from "../src/services/purchasing/device-trading-credit-sales.template.js";

const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

function word(top: number, left: number, text: string, line: number): string {
  return [5, 1, 1, line, 1, 1, left, top, Math.max(text.length * 8, 8), 18, 92, text].join("\t");
}

function invoiceTsv(): string {
  const rows: string[] = [header];
  const add = (top: number, line: number, cells: [number, string][]) => {
    cells.forEach(([left, text]) => rows.push(word(top, left, text, line)));
  };
  add(40, 1, [[340, "DEVICE"], [410, "TRADING"], [495, "PLC"]]);
  add(180, 2, [[420, "CREDIT"]]);
  add(240, 3, [[70, "Date:"], [115, "Aug"], [150, "20"], [178, "2026"], [218, "12:16"], [290, "Fs"], [315, "No."], [345, ":"], [357, "00012242"], [500, "Invoice"], [558, "No."], [588, ":"], [600, "CR-00004217"]]);
  add(302, 4, [[70, "Customer"], [135, "Name"], [290, "DOSE"], [330, "PHARMACY"], [640, "TIN"], [682, "0042716050"]]);
  add(368, 5, [[75, "Item"], [115, "Description"], [300, "Code"], [355, "Batch"], [450, "Expr."], [555, "Mfg."], [650, "UOM"], [700, "Quantity"], [775, "Unit"], [870, "Total"]]);
  add(406, 6, [[75, "Diclofin"], [300, "DI01"], [348, "3260068"], [440, "06/30/27"], [650, "PK"], [700, "5.00"], [770, "700.00"], [865, "3500.00"]]);
  add(640, 7, [[855, "Sub"], [900, "Total"], [960, "3500.00"]]);
  add(662, 8, [[850, "Non"], [888, "Tax"], [915, "(%)"], [985, "5.00"]]);
  add(684, 9, [[838, "Grand"], [895, "Total"], [960, "3500.00"]]);
  return rows.join("\n");
}

describe("DEVICE TRADING PLC spatial invoice template", () => {
  it("extracts fields by OCR coordinates and does not treat customer TIN or non-tax percent as supplier data", () => {
    const ocr = parseTesseractTsv(invoiceTsv());
    expect(isDeviceTradingCreditSalesTemplate(ocr.words)).toBe(true);

    const result = extractDeviceTradingCreditSales(ocr.words, ocr.confidence);
    expect(result).toMatchObject({
      source: "ocr",
      supplierName: "DEVICE TRADING PLC",
      supplierTin: null,
      invoiceNumber: "CR-00004217",
      invoiceDate: "2026-08-20T12:16:00.000Z",
      fsNumber: "00012242",
      subtotal: 3500,
      tax: null,
      grandTotal: 3500,
      paymentTerms: "CREDIT",
    });
    expect(result.items).toEqual([{
      productCode: "DI01",
      productName: "Diclofin",
      quantity: 5,
      unit: "PK",
      unitPrice: 700,
      lineTotal: 3500,
      batchNumber: "3260068",
      expiryDate: "2027-06-30T00:00:00.000Z",
    }]);
    expect(result.warnings).toEqual([]);
  });
});