import { addUtcDays, toUtcDayStart } from "../date-time.js";

export const REPORT_PERIODS = ["DAILY", "MONTHLY", "ANNUAL"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** Highest number of buckets we will materialise when filling zero periods. */
const MAX_BUCKETS = 5000;

export function isReportPeriod(value: string): value is ReportPeriod {
  return (REPORT_PERIODS as readonly string[]).includes(value);
}

/**
 * Maps a report period onto the `date_trunc` unit and the `to_char` pattern
 * used by the database-side sales-trend aggregation. The resulting keys sort
 * lexicographically in chronological order for every period.
 */
export function periodBucket(period: ReportPeriod): {
  trunc: string;
  format: string;
} {
  switch (period) {
    case "ANNUAL":
      return { trunc: "year", format: "YYYY" };
    case "MONTHLY":
      return { trunc: "month", format: "YYYY-MM" };
    case "DAILY":
    default:
      return { trunc: "day", format: "YYYY-MM-DD" };
  }
}

/** Formats a UTC date into the bucket key for the given period. */
export function bucketKeyFromDate(date: Date, period: ReportPeriod): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  if (period === "ANNUAL") {
    return year;
  }
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (period === "MONTHLY") {
    return `${year}-${month}`;
  }
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Enumerates every bucket key between two inclusive bounds so that periods
 * with no sales can be reported as zero instead of being silently omitted.
 */
export function enumerateBuckets(
  start: Date,
  end: Date,
  period: ReportPeriod,
): string[] {
  const keys: string[] = [];
  let cursor = toUtcDayStart(start);
  const last = toUtcDayStart(end);

  while (cursor.getTime() <= last.getTime() && keys.length < MAX_BUCKETS) {
    keys.push(bucketKeyFromDate(cursor, period));
    if (period === "ANNUAL") {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1));
    } else if (period === "MONTHLY") {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    } else {
      cursor = addUtcDays(cursor, 1);
    }
  }

  return keys;
}
