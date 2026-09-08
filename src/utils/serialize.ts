import { Prisma } from "@prisma/client";

function isDecimal(value: unknown): value is Prisma.Decimal {
  return value instanceof Prisma.Decimal;
}

/**
 * Recursively converts a value into a JSON-safe plain object:
 * - Prisma.Decimal -> number (exact up to Number.MAX_SAFE_INTEGER, which is
 *   far above any realistic inventory quantity; avoids leaking Decimal.js
 *   instances / stringified decimals into API responses)
 * - Date -> ISO-8601 string
 * Everything else is returned unchanged.
 */
export function serializeForApi(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isDecimal(value)) {
    return value.toNumber();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeForApi(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      out[key] = serializeForApi(record[key]);
    }
    return out;
  }
  return value;
}
