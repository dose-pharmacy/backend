/**
 * ============================================================================
 * ReportExportService
 * ============================================================================
 *
 * Export is a rendering concern only. Report *calculations* live in
 * `ReportQueryService` (and the individual report services); this module takes
 * the structured data those services already produced and serialises it.
 *
 * The boundary is intentionally narrow so that CSV, Excel, or PDF can all be
 * added later without duplicating a single financial formula:
 *
 *   filters -> ReportQueryService -> structured rows -> ReportExportService -> file
 *
 * No export endpoint is wired up yet — this is the prepared seam.
 */

export type ReportColumn<T> = {
  /** Property to read from each row. */
  key: Extract<keyof T, string>;
  /** Human-readable column header. */
  header: string;
  /** Optional value formatter (e.g. money/percent). Defaults to `String(value)`. */
  format?: (value: T[keyof T], row: T) => string;
};

export type ReportDataset<T> = {
  /** Stable identifier, e.g. `sales-trend`. Used for the file name. */
  report: string;
  columns: ReadonlyArray<ReportColumn<T>>;
  rows: ReadonlyArray<T>;
};

const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export const reportExportService = {
  /** Escapes one CSV cell: quotes when needed, doubles embedded quotes. */
  escapeCell(value: unknown): string {
    if (value === null || value === undefined) {
      return "";
    }
    const text = String(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  },

  /** Renders a structured dataset to a CSV document (with a header row). */
  toCsv<T>(dataset: ReportDataset<T>): string {
    const header = dataset.columns.map((column) => this.escapeCell(column.header));
    const body = dataset.rows.map((row) =>
      dataset.columns
        .map((column) => {
          const raw = row[column.key];
          const formatted = column.format ? column.format(raw, row) : raw;
          return this.escapeCell(formatted);
        })
        .join(","),
    );
    return [header.join(","), ...body].join("\r\n");
  },

  /** Consistent download metadata for a dataset. */
  describe<T>(dataset: ReportDataset<T>): {
    contentType: string;
    fileName: string;
  } {
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      contentType: CSV_CONTENT_TYPE,
      fileName: `${dataset.report}-${stamp}.csv`,
    };
  },
};

export type ReportExportService = typeof reportExportService;
