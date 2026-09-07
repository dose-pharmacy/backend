import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      "password",
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.set-cookie",
      "res.headers.set-cookie",
      "cookie",
      "cookies",
      "token",
      "accessToken",
      "refreshToken",
      "idToken",
      "sessionToken",
      "secret",
      "clientSecret",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_SECRET",
      "DATABASE_URL",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});
