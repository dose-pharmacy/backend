import { z } from "zod";
import { optionalUuidQuery } from "../inventory/common.js";

/**
 * Query contract for the new Finance Reporting module.
 *
 * The period is expressed as inclusive UTC calendar days with `from`/`to`
 * (YYYY-MM-DD or any ISO date). Omitted bounds fall back to the shared
 * reporting default (last 30 days). The service resolves the same window
 * through `resolveReportDateRange`, so `to` always covers the entire final day.
 */
const periodFields = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  locationId: optionalUuidQuery(),
  productGroupId: optionalUuidQuery(),
};

function refineDateRange<T extends { from?: Date; to?: Date }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  if (
    value.from &&
    value.to &&
    value.from.getTime() > value.to.getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["from"],
      message: "`from` must be on or before `to`",
    });
  }
}

export const TREND_GRANULARITIES = ["DAY", "MONTH", "YEAR"] as const;

export const financeReportQuerySchema = z
  .object({
    ...periodFields,
    granularity: z.enum(TREND_GRANULARITIES).optional(),
  })
  .superRefine(refineDateRange);

export const financeTrendsQuerySchema = z
  .object({
    ...periodFields,
    granularity: z.enum(TREND_GRANULARITIES).optional(),
  })
  .superRefine(refineDateRange);

/** The dashboard endpoint is deliberately filter-free (whole-company "now"). */
export const financeDashboardQuerySchema = z.object({});
