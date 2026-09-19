import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";

export type SortOrder = "asc" | "desc";

export type SortQuery = {
  sortBy?: string;
  sortOrder?: string;
};

export type SortConfig<TField extends string> = {
  /** Fields the endpoint accepts. Anything else is rejected. */
  allowed: readonly TField[];
  defaultField: TField;
  defaultOrder?: SortOrder;
};

/**
 * Resolves a caller-supplied `sortBy`/`sortOrder` against an explicit
 * allowlist.
 *
 * SECURITY: the resolved field is always one of the compile-time known
 * `allowed` values — an arbitrary caller string can never reach SQL. Each
 * caller maps the returned field onto a Prisma order-by (or a fixed
 * expression), so there is no string interpolation of user input.
 */
export function resolveSort<TField extends string>(
  query: SortQuery,
  config: SortConfig<TField>,
): { field: TField; order: SortOrder } {
  const requested = query.sortBy?.trim();

  if (requested !== undefined && requested !== "") {
    if (!config.allowed.includes(requested as TField)) {
      throw new AppError(
        422,
        ErrorCode.VALIDATION_ERROR,
        `Unsupported sortBy value "${requested}"`,
        { allowed: [...config.allowed] },
      );
    }
  }

  const order: SortOrder =
    query.sortOrder === "asc" || query.sortOrder === "desc"
      ? query.sortOrder
      : (config.defaultOrder ?? "desc");

  return {
    field: (requested as TField | undefined) ?? config.defaultField,
    order,
  };
}

/** Convenience helper: comparator for a numeric field honouring sort order. */
export function compareNumbers(
  a: number,
  b: number,
  order: SortOrder,
): number {
  return order === "asc" ? a - b : b - a;
}

/** Convenience helper: locale-agnostic comparator for text fields. */
export function compareStrings(a: string, b: string, order: SortOrder): number {
  const result = a.localeCompare(b);
  return order === "asc" ? result : -result;
}
