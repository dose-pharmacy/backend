import { z } from "zod";
import { hasMaxDecimalPlaces } from "../../utils/decimal.js";

export const uuidSchema = z.string().uuid("Must be a valid UUID");

export const idParamSchema = z.object({
  id: uuidSchema,
});

export const productIdParamSchema = z.object({
  productId: uuidSchema,
});

export const unitParamsSchema = z.object({
  productId: uuidSchema,
  unitId: uuidSchema,
});

export const booleanQuerySchema = z.enum(["true", "false"]);

/** Optional query string that becomes undefined when blank/omitted. */
export function optionalQueryString(max = 200) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    },
    z.string().trim().max(max).optional(),
  );
}

export function requiredString(max: number, label = "Value"): z.ZodString {
  return z.string().trim().min(1, `${label} is required`).max(max);
}

/**
 * Builds a validated non-negative / positive decimal number with a bounded
 * scale, matching the DECIMAL columns in the database.
 */
export function decimalNumber(options: {
  minInclusive: number;
  maxInclusive: number;
  decimalPlaces: number;
  message: string;
}) {
  const { minInclusive, maxInclusive, decimalPlaces, message } = options;
  return z.number().superRefine((value, ctx) => {
    if (!Number.isFinite(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a finite number" });
      return;
    }
    if (value < minInclusive || value > maxInclusive) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return;
    }
    if (!hasMaxDecimalPlaces(value, decimalPlaces)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Must have at most ${decimalPlaces} decimal place${decimalPlaces === 1 ? "" : "s"}`,
      });
    }
  });
}

/** A quantity expressed in a product unit (positive, up to 3 dp). */
export const quantitySchema = decimalNumber({
  minInclusive: 0.001,
  maxInclusive: 99999999999.999,
  decimalPlaces: 3,
  message: "Quantity must be greater than zero and at most 99999999999.999",
});

/** A conversion factor (positive, up to 4 dp, fits DECIMAL(12,4)). */
export const conversionFactorSchema = decimalNumber({
  minInclusive: 0.0001,
  maxInclusive: 99999999.9999,
  decimalPlaces: 4,
  message: "Conversion factor must be greater than zero and at most 99999999.9999",
});

/** A money amount (non-negative, up to 2 dp, fits DECIMAL(12,2)). */
export const moneySchema = decimalNumber({
  minInclusive: 0,
  maxInclusive: 9999999999.99,
  decimalPlaces: 2,
  message: "Amount must be between 0 and 9999999999.99 with at most 2 decimal places",
});

/** A percentage margin (fits DECIMAL(5,2)). */
export const profitMarginSchema = decimalNumber({
  minInclusive: 0,
  maxInclusive: 999.99,
  decimalPlaces: 2,
  message: "Margin must be between 0 and 999.99 with at most 2 decimal places",
});

/** A decimal threshold used for minimum stock / reorder point. */
export const thresholdSchema = decimalNumber({
  minInclusive: 0,
  maxInclusive: 99999999999.999,
  decimalPlaces: 3,
  message: "Value must be between 0 and 99999999999.999 with at most 3 decimal places",
});

/** Parses a date string into a Date. */
export const dateSchema = z.coerce.date();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
