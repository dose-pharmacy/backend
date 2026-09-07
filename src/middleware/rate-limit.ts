import { rateLimit } from "express-rate-limit";
import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { ErrorCode } from "../errors/error-codes.js";

const skipInTest: RequestHandler = (_req, _res, next) => next();

const tooManyRequestsBody = {
  success: false as const,
  error: {
    code: ErrorCode.RATE_LIMITED,
    message: "Too many requests. Please try again later.",
  },
};

export const generalRateLimiter: RequestHandler = env.isTest
  ? skipInTest
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json(tooManyRequestsBody);
      },
    });

export const authRateLimiter: RequestHandler = env.isTest
  ? skipInTest
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 40,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json(tooManyRequestsBody);
      },
    });
