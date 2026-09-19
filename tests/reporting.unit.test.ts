import { describe, expect, it } from "vitest";
import {
  resolveReportDateRange,
  toSqlTimestamp,
} from "../src/utils/reporting/date-range.js";
import {
  compareNumbers,
  compareStrings,
  resolveSort,
} from "../src/utils/reporting/sort.js";
import {
  bucketKeyFromDate,
  enumerateBuckets,
  isReportPeriod,
  periodBucket,
} from "../src/utils/reporting/period.js";
import {
  assertValidSlowMovingDefinition,
  daysSince,
  resolveThresholdDays,
} from "../src/services/financials/reports/slow-moving-evaluation.js";
import {
  safeRatio,
  toNumber,
} from "../src/services/financials/reports/report-query.service.js";
import { reportExportService } from "../src/services/financials/reports/report-export.service.js";
import {
  profitMarginReportQuerySchema,
  profitabilityReportQuerySchema,
  salesDetailQuerySchema,
  salesReportQuerySchema,
  salesSummaryQuerySchema,
  salesTrendQuerySchema,
} from "../src/validators/financials/reports.js";
import { AppError } from "../src/errors/app-error.js";

describe("resolveReportDateRange", () => {
  it("includes the whole dateTo day (not just its midnight)", () => {
    const { start, end } = resolveReportDateRange({
      dateFrom: new Date("2026-09-01"),
      dateTo: new Date("2026-09-19"),
    });
    expect(start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-19T23:59:59.999Z");
  });

  it("defaults to the last 30 days ending today", () => {
    const { start, end } = resolveReportDateRange({});
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(end.getUTCHours()).toBe(23);
  });

  it("rejects a reversed range", () => {
    expect(() =>
      resolveReportDateRange({
        dateFrom: new Date("2026-09-19"),
        dateTo: new Date("2026-09-01"),
      }),
    ).toThrow(AppError);
  });

  it("renders SQL timestamps as UTC wall clock", () => {
    expect(toSqlTimestamp(new Date("2026-09-19T00:00:00.000Z"))).toBe(
      "2026-09-19T00:00:00.000Z",
    );
  });
});

describe("resolveSort", () => {
  const config = { allowed: ["profit", "revenue"] as const, defaultField: "profit" as const };

  it("uses the default field and order", () => {
    expect(resolveSort({}, config)).toEqual({ field: "profit", order: "desc" });
  });

  it("accepts an allowlisted field and explicit order", () => {
    expect(resolveSort({ sortBy: "revenue", sortOrder: "asc" }, config)).toEqual({
      field: "revenue",
      order: "asc",
    });
  });

  it("rejects a field outside the allowlist", () => {
    expect(() => resolveSort({ sortBy: "revenue); drop table sale;--" }, config)).toThrow(
      AppError,
    );
  });

  it("ignores an unknown sortOrder and keeps the default", () => {
    expect(resolveSort({ sortOrder: "sideways" }, config).order).toBe("desc");
  });
});

describe("report period bucketing", () => {
  it("maps periods to trunc units and formats", () => {
    expect(periodBucket("DAILY")).toEqual({ trunc: "day", format: "YYYY-MM-DD" });
    expect(periodBucket("MONTHLY")).toEqual({ trunc: "month", format: "YYYY-MM" });
    expect(periodBucket("ANNUAL")).toEqual({ trunc: "year", format: "YYYY" });
  });

  it("validates period values", () => {
    expect(isReportPeriod("DAILY")).toBe(true);
    expect(isReportPeriod("WEEKLY")).toBe(false);
  });

  it("formats bucket keys per period", () => {
    const date = new Date("2026-09-05T12:00:00.000Z");
    expect(bucketKeyFromDate(date, "DAILY")).toBe("2026-09-05");
    expect(bucketKeyFromDate(date, "MONTHLY")).toBe("2026-09");
    expect(bucketKeyFromDate(date, "ANNUAL")).toBe("2026");
  });

  it("enumerates every bucket including gaps", () => {
    const days = enumerateBuckets(
      new Date("2026-09-01"),
      new Date("2026-09-04"),
      "DAILY",
    );
    expect(days).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);

    const months = enumerateBuckets(
      new Date("2026-01-15"),
      new Date("2026-04-02"),
      "MONTHLY",
    );
    expect(months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);

    const years = enumerateBuckets(new Date("2024-06-01"), new Date("2026-01-01"), "ANNUAL");
    expect(years).toEqual(["2024", "2025", "2026"]);
  });
});

describe("slow-moving thresholds", () => {
  it("maps fixed definitions", () => {
    expect(resolveThresholdDays("DAYS_30")).toBe(30);
    expect(resolveThresholdDays("DAYS_60")).toBe(60);
    expect(resolveThresholdDays("DAYS_90")).toBe(90);
    expect(resolveThresholdDays("DAYS_180")).toBe(180);
  });

  it("uses customDays for CUSTOM", () => {
    expect(resolveThresholdDays("CUSTOM", 45)).toBe(45);
  });

  it("returns null for a CUSTOM definition without a usable customDays", () => {
    expect(resolveThresholdDays("CUSTOM", null)).toBeNull();
    expect(resolveThresholdDays("CUSTOM", 0)).toBeNull();
    expect(resolveThresholdDays("CUSTOM", 400)).toBeNull();
  });

  it("validates CUSTOM strictly on write but allows fixed definitions", () => {
    expect(() => assertValidSlowMovingDefinition("CUSTOM")).toThrow(AppError);
    expect(() => assertValidSlowMovingDefinition("CUSTOM", 365)).not.toThrow();
    expect(() => assertValidSlowMovingDefinition("CUSTOM", 366)).toThrow(AppError);
    expect(() => assertValidSlowMovingDefinition("DAYS_90", null)).not.toThrow();
  });

  it("counts whole UTC days since a sale", () => {
    const today = new Date("2026-09-19T00:00:00.000Z");
    expect(daysSince(new Date("2026-09-09T15:30:00.000Z"), today)).toBe(10);
    expect(daysSince(new Date("2026-09-19T09:00:00.000Z"), today)).toBe(0);
  });
});

describe("numeric guards", () => {
  it("coerces raw aggregates safely", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(10n)).toBe(10);
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber(Number.NaN)).toBe(0);
  });

  it("never returns NaN or Infinity for margin ratios", () => {
    expect(safeRatio(40, 100)).toBe(40);
    expect(safeRatio(40, 0)).toBe(0);
    expect(safeRatio(0, 0)).toBe(0);
  });

  it("orders numbers and strings", () => {
    expect([3, 1, 2].sort((a, b) => compareNumbers(a, b, "asc"))).toEqual([1, 2, 3]);
    expect(compareStrings("a", "b", "desc")).toBeGreaterThan(0);
  });
});

describe("reportExportService", () => {
  const dataset = {
    report: "sales-trend",
    columns: [
      { key: "period" as const, header: "Period" },
      { key: "revenue" as const, header: "Revenue" },
    ],
    rows: [
      { period: "2026-09-01", revenue: 1200 },
      { period: 'Quoted, "value"', revenue: 5 },
    ],
  };

  it("renders a header row and escapes cells", () => {
    const csv = reportExportService.toCsv(dataset);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Period,Revenue");
    expect(lines[1]).toBe("2026-09-01,1200");
    expect(lines[2]).toBe('"Quoted, ""value""",5');
  });

  it("describes a download", () => {
    const described = reportExportService.describe(dataset);
    expect(described.contentType).toContain("text/csv");
    expect(described.fileName.startsWith("sales-trend-")).toBe(true);
    expect(described.fileName.endsWith(".csv")).toBe(true);
  });

  it("renders empty cells for null values", () => {
    expect(reportExportService.escapeCell(null)).toBe("");
  });
});

describe("report query validation", () => {
  it("rejects an unsupported sortBy", () => {
    expect(profitabilityReportQuerySchema.safeParse({ sortBy: "hax" }).success).toBe(false);
    expect(salesReportQuerySchema.safeParse({ sortBy: "totalAmount" }).success).toBe(true);
  });

  it("rejects a reversed date range", () => {
    const result = salesSummaryQuerySchema.safeParse({
      dateFrom: "2026-09-19",
      dateTo: "2026-09-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an equal dateFrom/dateTo (single day)", () => {
    expect(
      salesTrendQuerySchema.safeParse({ dateFrom: "2026-09-19", dateTo: "2026-09-19" })
        .success,
    ).toBe(true);
  });

  it("rejects pagination outside the allowed bounds", () => {
    expect(salesDetailQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(salesDetailQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(salesDetailQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(salesDetailQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it("accepts only allowlisted detail sort fields", () => {
    expect(profitMarginReportQuerySchema.safeParse({ sortBy: "actualMargin" }).success).toBe(
      true,
    );
    expect(profitMarginReportQuerySchema.safeParse({ sortBy: "cost" }).success).toBe(true);
    expect(profitMarginReportQuerySchema.safeParse({ sortBy: "profit" }).success).toBe(false);
    expect(salesDetailQuerySchema.safeParse({ sortBy: "lineTotal" }).success).toBe(true);
  });

  it("validates the trend period", () => {
    expect(salesTrendQuerySchema.safeParse({ period: "MONTHLY" }).success).toBe(true);
    expect(salesTrendQuerySchema.safeParse({ period: "WEEKLY" }).success).toBe(false);
  });
});
