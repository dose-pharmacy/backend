import type { RequestHandler } from "express";
import { logger } from "../config/logger.js";

export const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    logger.info(
      {
        method: req.method,
        path: req.originalUrl.split("?")[0],
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
      },
      "HTTP request",
    );
  });
  next();
};
