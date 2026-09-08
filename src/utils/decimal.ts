import { Prisma } from "@prisma/client";

export type DecimalValue = Prisma.Decimal | number | string;

export const STOCK_QUANTITY_PRECISION = 3;
export const CONVERSION_FACTOR_PRECISION = 4;

/**
 * Builds a Prisma.Decimal from a JS number/string. We always go through the
 * shortest string representation of the number so values such as 0.1 never
 * carry binary floating point noise into the database.
 */
export function toDecimal(value: DecimalValue): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot convert a non-finite number to Decimal");
    }
    return new Prisma.Decimal(String(value));
  }
  return new Prisma.Decimal(value);
}

/** Rounds a Decimal to `decimalPlaces` using half-up rounding. */
export function roundTo(value: Prisma.Decimal, decimalPlaces: number): Prisma.Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

/** True when the number has at most `decimalPlaces` decimal digits. */
export function hasMaxDecimalPlaces(value: number, decimalPlaces: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  const text = String(value);
  // Reject scientific notation (e.g. 1e-7); callers constrain ranges anyway.
  if (/e/i.test(text)) {
    return false;
  }
  const dotIndex = text.indexOf(".");
  if (dotIndex === -1) {
    return true;
  }
  return text.length - dotIndex - 1 <= decimalPlaces;
}
