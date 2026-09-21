import type { Response } from "express";
import type { PaginationMeta } from "../types/api.js";
import { serializeForApi } from "./serialize.js";

type Options = {
  status?: number;
  meta?: PaginationMeta;
  /** Server-computed aggregate counts over the filtered dataset. */
  summary?: Record<string, unknown>;
};

/** Sends the standard `{ success: true, data, meta?, summary? }` envelope. */
export function sendSuccess<T>(res: Response, data: T, options: Options = {}): void {
  const { status = 200, meta, summary } = options;
  const body: Record<string, unknown> = {
    success: true,
    data: serializeForApi(data),
  };
  if (meta) {
    body.meta = meta;
  }
  if (summary) {
    body.summary = summary;
  }
  res.status(status).json(body);
}
