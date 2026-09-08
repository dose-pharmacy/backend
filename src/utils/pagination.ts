import type { PaginationMeta } from "../types/api.js";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type PageQuery = {
  page?: number;
  limit?: number;
};

export function resolvePagination(query: PageQuery): {
  page: number;
  limit: number;
  skip: number;
  take: number;
} {
  const page = Math.max(DEFAULT_PAGE, query.page ?? DEFAULT_PAGE);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE),
  );
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}
