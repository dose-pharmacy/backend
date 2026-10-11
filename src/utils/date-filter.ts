import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import { addUtcDays, toUtcDayStart } from "./date-time.js";

/**
 * List date filters for the purchasing modules (purchase orders, goods
 * receipts, supplier invoices).
 *
 * Business timezone
 * -----------------
 * The application stores `DateTime` columns as UTC wall-clock values and every
 * existing date helper (`utils/date-time.ts`, `utils/reporting/date-range.ts`,
 * the financial reports) reasons in UTC calendar days. No separate business
 * timezone is configured, so all preset boundaries are computed in UTC: "today"
 * is the current UTC calendar day, "this week" the current ISO week
 * (Monday 00:00 UTC .. next Monday 00:00 UTC) and "this month" the current UTC
 * calendar month.
 *
 * Range semantics
 * ---------------
 * Ranges are half-open instants `[gte, lt)`: the start is inclusive and the end
 * is the start of the *next* period (exclusive). This includes every timestamp
 * on the final calendar day while avoiding the classic
 * `23:59:59.999` boundary miss.
 */

export const DATE_PRESETS = ["today", "this_week", "this_month"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

/** Half-open instant range `[gte, lt)`; either bound may be omitted. */
export type DateRange = { gte?: Date; lt?: Date };

export type DateFilterInput = {
  datePreset?: DatePreset;
  /** Inclusive first calendar day (UTC). */
  dateFrom?: Date;
  /** Inclusive last calendar day (UTC). */
  dateTo?: Date;
};

/** Monday, following the project's ISO-8601 week-start convention. */
const WEEK_START_DAY = 1;

/** Resolves a named preset to its UTC calendar window. */
export function presetRange(preset: DatePreset, now: Date = new Date()): DateRange {
  const today = toUtcDayStart(now);
  switch (preset) {
    case "today":
      return { gte: today, lt: addUtcDays(today, 1) };
    case "this_week": {
      const day = today.getUTCDay();
      const offset = (day - WEEK_START_DAY + 7) % 7;
      const monday = addUtcDays(today, -offset);
      return { gte: monday, lt: addUtcDays(monday, 7) };
    }
    case "this_month": {
      const first = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
      );
      const nextMonth = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
      );
      return { gte: first, lt: nextMonth };
    }
  }
}

/**
 * Resolves a list date filter into instant bounds.
 *
 * - A preset takes precedence over custom bounds and always yields a closed
 *   period (`gte` and `lt`).
 * - A custom range accepts `dateFrom`/`dateTo` independently: supplying only
 *   one leaves the other side open-ended (no lower / no upper bound), matching
 *   the existing financial list endpoints.
 * - No parameters at all means no date restriction (`undefined`).
 * - `dateFrom` after `dateTo` is rejected with a 422 (defense in depth; the API
 *   boundary validation already enforces this).
 */
export function resolveDateFilter(
  input: DateFilterInput,
  now: Date = new Date(),
): DateRange | undefined {
  if (input.datePreset) {
    return presetRange(input.datePreset, now);
  }

  if (!input.dateFrom && !input.dateTo) {
    return undefined;
  }

  const range: DateRange = {};
  if (input.dateFrom) {
    range.gte = toUtcDayStart(input.dateFrom);
  }
  if (input.dateTo) {
    range.lt = addUtcDays(toUtcDayStart(input.dateTo), 1);
  }
  if (range.gte && range.lt && range.gte.getTime() >= range.lt.getTime()) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      "`dateFrom` must be on or before `dateTo`",
    );
  }
  return range;
}
