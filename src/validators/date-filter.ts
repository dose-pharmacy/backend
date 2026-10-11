import { z } from "zod";
import { DATE_PRESETS, type DatePreset } from "../utils/date-filter.js";

/**
 * Shared query-parameter fragments for list date filters. Kept separate from
 * the per-module validators so every purchasing list endpoint accepts the exact
 * same contract.
 *
 * - `datePreset`: `today` | `this_week` | `this_month`
 * - `dateFrom` / `dateTo`: inclusive calendar dates (`YYYY-MM-DD`), UTC
 *
 * Blank strings are treated as absent so an empty `?dateFrom=` never fails.
 */
export const datePresetQuerySchema = z.enum(DATE_PRESETS);

/** Empty/blank query values become `undefined` before date coercion. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

export const dateFromQuerySchema = z.preprocess(
  blankToUndefined,
  z.coerce.date().optional(),
);

export const dateToQuerySchema = z.preprocess(
  blankToUndefined,
  z.coerce.date().optional(),
);

export const dateFilterQueryShape = {
  datePreset: datePresetQuerySchema.optional(),
  dateFrom: dateFromQuerySchema,
  dateTo: dateToQuerySchema,
};

export type DateFilterQuery = {
  datePreset?: DatePreset;
  dateFrom?: Date;
  dateTo?: Date;
};

/**
 * Cross-field rules shared by every list endpoint:
 *  - a preset and custom bounds are mutually exclusive (reject both);
 *  - `dateFrom` must not be after `dateTo`.
 *
 * Returned as issues so each validator can attach them via `superRefine`.
 */
export function dateFilterIssues(input: DateFilterQuery): Array<{
  path: (string | number)[];
  message: string;
}> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  if (input.datePreset && (input.dateFrom || input.dateTo)) {
    issues.push({
      path: ["datePreset"],
      message: "datePreset cannot be combined with dateFrom or dateTo",
    });
  }
  if (
    input.dateFrom &&
    input.dateTo &&
    input.dateFrom.getTime() > input.dateTo.getTime()
  ) {
    issues.push({
      path: ["dateFrom"],
      message: "dateFrom must be on or before dateTo",
    });
  }
  return issues;
}
