import { describe, expect, it } from "vitest";
import { parseTesseractTsv } from "../src/services/purchasing/invoice-ocr.service.js";
import { invoiceExtractionService } from "../src/services/purchasing/invoice-extraction.service.js";

/**
 * Layout-level tests for photographed invoices.
 *
 * A photo reaches the database as Tesseract TSV word boxes. If those boxes are
 * flattened into one long line, no downstream parser can tell a header field
 * from a table row — which is exactly how a whole invoice used to extract as
 * `items: []` with everything else null.
 */

const TSV_HEADER =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

/** One word: its cell index within the row sets its row/line box. */
function word(
  rowIndex: number,
  cellIndex: number,
  left: number,
  top: number,
  text: string,
  conf = 90,
): string {
  return [
    5,
    1,
    1,
    rowIndex + 1,
    cellIndex + 1,
    cellIndex + 1,
    left,
    top,
    Math.round(text.length * 9.2),
    20,
    conf,
    text,
  ].join("\t");
}

function tsv(rows: { top: number; cells: [number, string][] }[]): string {
  const lines: string[] = [TSV_HEADER];

  rows.forEach((row, rowIndex) => {
    row.cells.forEach(([left, text], cellIndex) => {
      // Jittered boxes: real OCR never returns perfectly aligned words.
      lines.push(word(rowIndex, cellIndex, left, row.top + (cellIndex % 2), text));
    });
  });

  return lines.join("\n");
}

describe("OCR layout reconstruction", () => {
  it("keeps printed rows and columns when every word is its own tesseract line", () => {
    const result = parseTesseractTsv(
      tsv([
        {
          top: 100,
          cells: [
            [70, "Item"],
            [112, "Description"],
            [300, "Code"],
            [500, "Quantity"],
          ],
        },
        {
          top: 130,
          cells: [
            [70, "Diclofin"],
            [300, "DI01"],
            [500, "5.00"],
          ],
        },
      ]),
    );

    expect(result.text.split("\n")).toEqual([
      "Item Description\tCode\tQuantity",
      "Diclofin\tDI01\t5.00",
    ]);
    expect(result.confidence).toBe(90);
  });

  it("averages confidence over scored words only", () => {
    const lines = [
      TSV_HEADER,
      word(0, 0, 70, 100, "Invoice", 80),
      word(0, 1, 200, 100, "No", 60),
      word(0, 2, 300, 100, "line1", -1),
    ];

    const result = parseTesseractTsv(lines.join("\n"));

    expect(result.confidence).toBe(70);
  });

  it("ignores non-word tsv rows", () => {
    const result = parseTesseractTsv(
      [
        TSV_HEADER,
        ["1", "1", "0", "0", "0", "0", "0", "0", "1000", "1000", "-1", ""].join("\t"),
        ["4", "1", "1", "1", "1", "0", "70", "100", "100", "20", "-1", ""].join("\t"),
        word(0, 0, 70, 100, "DEVICE"),
      ].join("\n"),
    );

    expect(result.text).toBe("DEVICE");
  });
});

describe("photographed invoice end to end", () => {
  it("extracts the DEVICE TRADING PLC credit sales attachment", async () => {
    // The attached photo, as Tesseract reads it (word boxes, not text).
    const ocr = parseTesseractTsv(
      tsv([
        { top: 38, cells: [[340, "DEVICE"], [410, "TRADING"], [495, "PLC"]] },
        {
          top: 74,
          cells: [
            [70, "Sub"], [96, "City"], [132, ":"], [142, "N/S/LAFTO"],
            [290, "Kebele:"], [350, "01"],
            [500, "Bldg/lt.No."], [585, "NEW"],
          ],
        },
        {
          top: 94,
          cells: [
            [70, "Tel"], [98, "."], [108, "1"], [118, ":"], [128, "0949"],
            [165, "46"], [185, "12"], [205, "95"],
            [290, "Tel"], [318, "."], [328, "2"], [338, ":"], [348, "0081944994"],
            [500, "Fax:"], [535, "+000"], [570, "000"], [600, "00"], [620, "00"], [640, "00"],
          ],
        },
        {
          top: 115,
          cells: [
            [70, "TIN:"], [125, "0046966889"],
            [290, "VAT"], [322, "Reg."], [368, "No."], [400, ":"],
          ],
        },
        { top: 136, cells: [[70, "CA/COEY"]] },
        { top: 178, cells: [[420, "CREDIT"], [495, "Sales"], [545, "Attachment"]] },
        {
          top: 212,
          cells: [[70, "Shop/Store:"], [290, "Sales"], [335, "Agent/Representative:"]],
        },
        {
          top: 240,
          cells: [
            [70, "Date:"], [115, "Aug"], [150, "20"], [178, "2026"], [218, "12:16"],
            [290, "Fs"], [315, "No."], [345, ":"], [357, "00012242"],
            [500, "Invoice"], [558, "No."], [588, ":"], [600, "CR-00004217"],
          ],
        },
        { top: 285, cells: [[70, "Customer"], [135, "Information"]] },
        {
          top: 302,
          cells: [
            [70, "Customer"], [135, "Name"], [178, ":"],
            [290, "DOSE"], [330, "PHARMACY"],
            [640, "TIN"], [670, ":"], [682, "0042716050"],
          ],
        },
        { top: 328, cells: [[70, "ID"], [92, "No."], [122, ":"], [290, "DO01"]] },
        {
          top: 368,
          cells: [
            [75, "Item"], [115, "Description"],
            [300, "Code"],
            [355, "Batch"], [402, "#"],
            [450, "Expr."], [492, "Date"],
            [555, "Mfg."], [592, "Date"],
            [650, "UOM"],
            [700, "Quantity"],
            [775, "Unit"], [812, "Price"],
            [870, "Total"], [912, "Price"],
          ],
        },
        {
          top: 406,
          cells: [
            [75, "Diclofin"],
            [300, "DI01"],
            [348, "3260068"],
            [440, "06/30/27"],
            [650, "PK"],
            [700, "5.00"],
            [770, "700.00"],
            [865, "3500.00"],
          ],
        },
        {
          top: 442,
          cells: [[650, "PK"], [700, "5.00"], [770, "700.00"], [865, "3500.00"]],
        },
        { top: 640, cells: [[855, "Sub"], [900, "Total"], [960, "3500.00"]] },
        { top: 662, cells: [[850, "Non"], [888, "Tax"], [915, "(%)"], [985, "5.00"]] },
        { top: 684, cells: [[838, "Grand"], [895, "Total"], [960, "3500.00"]] },
        {
          top: 738,
          cells: [
            [70, "AMOUNT"], [150, "JOINT"], [205, "IN"], [232, "WORDS"],
            [310, "(THREE"], [390, "THOUSAND"], [490, "FIVE"], [536, "HUNDRED"],
            [625, "BIRR"], [690, "AND"], [726, "CENTS"], [800, "ONLY)"],
          ],
        },
        { top: 764, cells: [[70, "Amount:"]] },
      ]),
    );

    const result = await invoiceExtractionService.extract({ text: ocr.text });

    expect(result.supplierName).toBe("DEVICE TRADING PLC");
    expect(result.supplierTin).toBe("0046966889");
    expect(result.invoiceNumber).toBe("CR-00004217");
    expect(result.fsNumber).toBe("00012242");
    expect(result.invoiceDate).toBe("2026-08-20T00:00:00.000Z");
    expect(result.subtotal).toBe(3500);
    expect(result.tax).toBe(5);
    expect(result.grandTotal).toBe(3500);
    expect(result.paymentTerms).toBe("CREDIT");
    expect(result.skippedLineCount).toBe(0);

    expect(result.items).toEqual([
      {
        productCode: "DI01",
        productName: "Diclofin",
        quantity: 5,
        unit: "PK",
        unitPrice: 700,
        lineTotal: 3500,
        batchNumber: "3260068",
        expiryDate: "2027-06-30T00:00:00.000Z",
      },
    ]);

    // The buyer TIN must never be mistaken for the supplier TIN.
    expect(result.supplierTin).not.toBe("0042716050");
    // The repeated amount-only row is flagged, not silently invented.
    expect(result.warnings.join(" ")).toContain("repeat the previous line item");
    expect(result.warnings.join(" ")).not.toContain("No line items");
    expect(result.warnings.join(" ")).not.toContain("Invoice number was not found");
  });
});
