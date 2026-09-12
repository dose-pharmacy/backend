import cors from "cors";
import helmet from "helmet";
import type { CorsOptions } from "cors";
import { env } from "../config/env.js";

export const helmetMiddleware = helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
});

export const corsOptions: CorsOptions = {
  // Development/testing: reflect any request Origin so local and tunnelled
  // frontends can use credentialed requests. Production keeps the allowlist.
  origin: env.isProduction
    ? (origin, callback) => {
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin not allowed by CORS"));
      }
    : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

export const corsMiddleware = cors(corsOptions);
