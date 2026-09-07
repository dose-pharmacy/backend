import type { RequestHandler } from "express";
import type { AnyZodObject, ZodEffects, ZodTypeAny } from "zod";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";

type ZodSchema = AnyZodObject | ZodEffects<ZodTypeAny>;

type ValidationTarget = {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
};

export function validate(schemas: ValidationTarget): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query) as typeof req.query;
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(error);
        return;
      }
      next(
        new AppError(
          422,
          ErrorCode.VALIDATION_ERROR,
          "Request validation failed",
        ),
      );
    }
  };
}
