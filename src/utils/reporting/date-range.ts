import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { addUtcDays, startOfTodayUtc, toUtcDayStart } from "../date-time.js";

const LAST_MILLISECOND_OF_DAY = 86_400_000 - 1;

export type ReportDateRangeInput = {
  dateFrom?: Date;
  dateTo?: Date;
};

export type ReportDateRange = {
  /** First instant included in the range (UTC start of `dateFrom`). */
  start: Date;
  /** Last instant included in the range (UTC end-of-day of `dateTo`). */
  end: Date;
};

/**
 * Resolves a report date range with a single, consistent convention shared by
 * every report endpoint:
 *
 *   - `dateFrom` -> the START of that UTC day (inclusive)
 *   - `dateTo`   -> the END of that UTC day (inclusive)
 *
 * The default window (when neither bound is supplied) is the last
 * `defaultDays` days, ending today. This is the same convention used by the
 * pharmacy's `date-time` helpers (UTC calendar days), so a `dateTo` of
 * `2026-09-19` includes everything up to `2026-09-19T23:59:59.999Z` instead of
 * silently dropping the rest of the day.
 *
 * Throws a 422 when `dateFrom > dateTo`.
 */
export function resolveReportDateRange(
  { dateFrom, dateTo }: ReportDateRangeInput,
  options: { defaultDays?: number } = {},
): ReportDateRange {
  const defaultDays = options.defaultDays ?? 30;

  const start = dateFrom
    ? toUtcDayStart(dateFrom)
    : addUtcDays(startOfTodayUtc(), -defaultDays);

  const end = dateTo
    ? new Date(toUtcDayStart(dateTo).getTime() + LAST_MILLISECOND_OF_DAY)
    : new Date(startOfTodayUtc().getTime() + LAST_MILLISECOND_OF_DAY);

  if (start.getTime() > end.getTime()) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      "`dateFrom` must be on or before `dateTo`",
    );
  }

  return { start, end };
}

/**
 * Renders a Date as the UTC wall-clock `timestamp` literal used by the raw
 * reporting SQL. The reporting columns are timezone-less `timestamp(3)`, and
 * Prisma persists `DateTime` values as UTC wall clock, so the ISO string with
 * a `Z` suffix maps exactly onto the stored value when cast to `timestamp`.
 */
export function toSqlTimestamp(date: Date): string {
  return date.toISOString();
}
