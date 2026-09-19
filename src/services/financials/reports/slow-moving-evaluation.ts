import { Prisma, type SlowMovingDefinition } from "@prisma/client";
import { AppError } from "../../../errors/app-error.js";
import { ErrorCode } from "../../../errors/error-codes.js";
import { prisma } from "../../../database/prisma.js";
import { startOfTodayUtc, toUtcDayStart } from "../../../utils/date-time.js";
import { toSqlTimestamp } from "../../../utils/reporting/date-range.js";
import { VALID_SALE_STATUS } from "./report-query.service.js";

const DAY_MS = 86_400_000;

/**
 * Advisory lock key for the slow-moving evaluation. Any two concurrent
 * evaluations (two HTTP requests, two processes) contend on this lock, so only
 * one can run at a time. It is an application constant, not a row id.
 */
export const SLOW_MOVING_EVALUATION_LOCK_KEY = 727_000_001;

/** Fixed thresholds for the well-known definition types. */
export const SLOW_MOVING_THRESHOLDS: Record<
  Exclude<SlowMovingDefinition, "CUSTOM">,
  number
> = {
  DAYS_30: 30,
  DAYS_60: 60,
  DAYS_90: 90,
  DAYS_180: 180,
};

export const CUSTOM_DAYS_MIN = 1;
export const CUSTOM_DAYS_MAX = 365;

/**
 * The single place that maps a slow-moving definition onto the number of days
 * a product must go unsold before it is flagged.
 *
 * Returns `null` for a `CUSTOM` definition whose `customDays` is missing or out
 * of range — a pre-existing/legacy row that is safe to skip rather than crash
 * the whole evaluation. Writes go through `assertValidSlowMovingDefinition`,
 * so this only defends against data that predates validation.
 */
export function resolveThresholdDays(
  definitionType: SlowMovingDefinition,
  customDays?: number | null,
): number | null {
  if (definitionType === "CUSTOM") {
    if (
      customDays === null ||
      customDays === undefined ||
      !Number.isInteger(customDays) ||
      customDays < CUSTOM_DAYS_MIN ||
      customDays > CUSTOM_DAYS_MAX
    ) {
      return null;
    }
    return customDays;
  }
  return SLOW_MOVING_THRESHOLDS[definitionType] ?? null;
}

/** Validates a definition before it is persisted. */
export function assertValidSlowMovingDefinition(
  definitionType: SlowMovingDefinition,
  customDays?: number | null,
): void {
  if (definitionType !== "CUSTOM") {
    return;
  }
  if (
    customDays === null ||
    customDays === undefined ||
    !Number.isInteger(customDays) ||
    customDays < CUSTOM_DAYS_MIN ||
    customDays > CUSTOM_DAYS_MAX
  ) {
    throw new AppError(
      422,
      ErrorCode.INVALID_SLOW_MOVING_DEFINITION,
      `Custom days must be provided for CUSTOM definition type and be between ${CUSTOM_DAYS_MIN} and ${CUSTOM_DAYS_MAX}`,
    );
  }
}

/** Whole-day difference between today (UTC) and a past instant (UTC). */
export function daysSince(date: Date, today: Date = startOfTodayUtc()): number {
  return Math.round(
    (today.getTime() - toUtcDayStart(date).getTime()) / DAY_MS,
  );
}

export type SlowMovingEvaluationResult = {
  evaluated: number;
  flagged: number;
  unflagged: number;
  /** Configs skipped because their stored definition is invalid (legacy data). */
  skipped: number;
  evaluatedAt: Date;
  durationMs: number;
};

type EvaluatedConfig = {
  id: string;
  lastSaleDate: Date | null;
  daysSinceLastSale: number | null;
  isFlagged: boolean;
};

/**
 * Evaluates every slow-moving configuration in a single short transaction:
 *
 *   1. take a PostgreSQL transaction-scoped advisory lock (concurrency guard)
 *   2. load all configs in one query
 *   3. fetch the latest valid sale per product in ONE grouped query (no N+1)
 *   4. compute `daysSinceLastSale` / `thresholdDays` / `isFlagged` in memory
 *   5. apply every row in a single bulk UPDATE
 *
 * Because it all happens inside one transaction, the state is never left
 * partially updated: either every config reflects the new evaluation or none
 * does. Running it twice on unchanged data produces the same state.
 *
 * Never-sold products keep the established behaviour: `lastSaleDate = null`,
 * `daysSinceLastSale = null`, `isFlagged = false` — they are not flagged by an
 * undefined rule.
 */
export async function evaluateSlowMoving(): Promise<SlowMovingEvaluationResult> {
  const startedAt = Date.now();

  const outcome = await prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${SLOW_MOVING_EVALUATION_LOCK_KEY}::bigint) AS locked
    `;
    if (!lock[0]?.locked) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        "A slow-moving evaluation is already running. Try again shortly.",
      );
    }

    const configs = await tx.slowMovingConfiguration.findMany({
      select: {
        id: true,
        productId: true,
        definitionType: true,
        customDays: true,
      },
    });

    if (configs.length === 0) {
      return { evaluated: 0, flagged: 0, skipped: 0 };
    }

    // One query for the latest valid sale of every configured product. Joining
    // the config table keeps this free of a giant `IN (...)` product-id list.
    const latestSales = await tx.$queryRaw<
      Array<{ productId: string; lastSaleDate: Date | null }>
    >`
      SELECT c."productId" AS "productId",
             MAX(s."createdAt") AS "lastSaleDate"
      FROM slow_moving_configuration c
      JOIN sale_item si ON si."productId" = c."productId"
      JOIN sale s ON s.id = si."saleId"
      WHERE s.status = ${VALID_SALE_STATUS}::"SaleStatus"
      GROUP BY c."productId"
    `;

    const latestByProduct = new Map(
      latestSales.map((row) => [row.productId, row.lastSaleDate] as const),
    );

    const today = startOfTodayUtc();
    const evaluatedRows: EvaluatedConfig[] = [];
    let skipped = 0;

    for (const config of configs) {
      const thresholdDays = resolveThresholdDays(
        config.definitionType,
        config.customDays,
      );
      if (thresholdDays === null) {
        skipped += 1;
        continue;
      }

      const lastSaleDate = latestByProduct.get(config.productId) ?? null;
      const daysSinceLastSale = lastSaleDate
        ? daysSince(lastSaleDate, today)
        : null;
      const isFlagged =
        daysSinceLastSale === null ? false : daysSinceLastSale >= thresholdDays;

      evaluatedRows.push({
        id: config.id,
        lastSaleDate,
        daysSinceLastSale,
        isFlagged,
      });
    }

    if (evaluatedRows.length > 0) {
      // A single UPDATE for the whole evaluation keeps the transaction short and
      // guarantees the evaluation result is applied atomically.
      // Id columns are PostgreSQL TEXT (Prisma maps String ids to text), so the
      // id is bound without a cast; the temporal/int/bool columns are cast so
      // the VALUES list has unambiguous types.
      const values = evaluatedRows.map(
        (row) => Prisma.sql`(
          ${row.id},
          ${row.lastSaleDate ? toSqlTimestamp(row.lastSaleDate) : null}::timestamp,
          ${row.daysSinceLastSale}::int,
          ${row.isFlagged}::boolean
        )`,
      );

      await tx.$executeRaw`
        UPDATE slow_moving_configuration AS c
        SET "lastSaleDate" = v.last_sale_date,
            "daysSinceLastSale" = v.days_since,
            "isFlagged" = v.flagged,
            "updatedAt" = now()
        FROM (VALUES ${Prisma.join(values)})
          AS v(id, last_sale_date, days_since, flagged)
        WHERE c.id = v.id
      `;
    }

    const flagged = evaluatedRows.filter((row) => row.isFlagged).length;

    return {
      evaluated: evaluatedRows.length,
      flagged,
      skipped,
    };
  });

  return {
    evaluated: outcome.evaluated,
    flagged: outcome.flagged,
    unflagged: outcome.evaluated - outcome.flagged,
    skipped: outcome.skipped,
    evaluatedAt: new Date(),
    durationMs: Date.now() - startedAt,
  };
}
