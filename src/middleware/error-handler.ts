import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import type { ApiErrorBody } from "../types/api.js";

function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiErrorBody = {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  res.status(statusCode).json(body);
}

function prismaError(error: Prisma.PrismaClientKnownRequestError): AppError {
  if (error.code === "P2002") {
    return new AppError(409, ErrorCode.CONFLICT, "A matching record already exists");
  }
  if (error.code === "P2025") {
    return new AppError(404, ErrorCode.NOT_FOUND, "Record not found");
  }
  return new AppError(500, ErrorCode.DATABASE_ERROR, "A database error occurred");
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(
      404,
      ErrorCode.NOT_FOUND,
      `Route ${req.method} ${req.originalUrl} was not found`,
    ),
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(
        { err, path: req.path, method: req.method, code: err.code },
        err.message,
      );
    } else {
      logger.warn(
        { path: req.path, method: req.method, code: err.code },
        err.message,
      );
    }

    sendError(
      res,
      err.statusCode,
      err.code,
      err.message,
      env.isProduction ? undefined : err.details,
    );
    return;
  }

  if (err instanceof ZodError) {
    sendError(res, 422, ErrorCode.VALIDATION_ERROR, "Request validation failed", {
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = prismaError(err);
    logger.error({ err, path: req.path, method: req.method }, mapped.message);
    sendError(res, mapped.statusCode, mapped.code, mapped.message);
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled application error");

  sendError(
    res,
    500,
    ErrorCode.INTERNAL_ERROR,
    env.isProduction ? "An unexpected error occurred" : err instanceof Error ? err.message : "An unexpected error occurred",
  );
}
