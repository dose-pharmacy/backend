import type { Response } from "express";
import type { PaginationMeta } from "../types/api.js";
import { serializeForApi } from "./serialize.js";

type Options = {
  status?: number;
  meta?: PaginationMeta;
};

/** Sends the standard `{ success: true, data, meta? }` envelope. */
export function sendSuccess<T>(res: Response, data: T, options: Options = {}): void {
  const { status = 200, meta } = options;
  const body: Record<string, unknown> = {
    success: true,
    data: serializeForApi(data),
  };
  if (meta) {
    body.meta = meta;
  }
  res.status(status).json(body);
}
