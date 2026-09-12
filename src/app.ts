import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth/auth.js";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import {
  authRateLimiter,
  generalRateLimiter,
} from "./middleware/rate-limit.js";
import { requestLogger } from "./middleware/request-logger.js";
import { corsMiddleware, helmetMiddleware } from "./middleware/security.js";
import { docsRouter } from "./routes/docs.js";
import { healthRouter } from "./routes/health.js";
import { v1Router } from "./routes/v1.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(requestLogger);
app.use(generalRateLimiter);
app.use(env.authBasePath, authRateLimiter);

const betterAuthHandler = toNodeHandler(auth);
app.use((req, res, next) => {
  const path = req.originalUrl.split("?")[0] ?? "";
  if (path === env.authBasePath || path.startsWith(`${env.authBasePath}/`)) {
    void betterAuthHandler(req, res);
    return;
  }
  next();
});

app.use(express.json({ limit: env.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: env.bodyLimit }));

app.use("/health", healthRouter);
app.use("/api-docs", docsRouter);
app.use(env.apiPrefix, v1Router);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
