import { z } from "zod";
import {
  optionalQueryString,
  optionalUuidQuery,
  paginationQuerySchema,
} from "../inventory/common.js";
import {
  dateFromQuerySchema,
  dateToQuerySchema,
  dateRangeRefinement,
} from "./reports.js";
import { StockTransactionType } from "@prisma/client";

/**
 * Query schema for GET /financials/reports/narcotics.
 * page/limit (max 100), UUID filters and the shared date-range refinement.
 */
export const narcoticReportQuerySchema = z
  .object({
    search: optionalQueryString(200),
    productId: optionalUuidQuery(),
    locationId: optionalUuidQuery(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
  })
  .merge(paginationQuerySchema)
  .superRefine(dateRangeRefinement);

/**
 * Query schema for GET /financials/reports/narcotics/activity. movementType
 * must be one of the EXISTING StockTransactionType enum values — narcotic
 * sales stay SALE, purchases stay PURCHASE (no new movement types).
 */
export const narcoticActivityQuerySchema = z
  .object({
    productId: optionalUuidQuery(),
    locationId: optionalUuidQuery(),
    batchId: optionalUuidQuery(),
    movementType: z.nativeEnum(StockTransactionType).optional(),
    dateFrom: dateFromQuerySchema,
    dateTo: dateToQuerySchema,
  })
  .merge(paginationQuerySchema)
  .superRefine(dateRangeRefinement);
