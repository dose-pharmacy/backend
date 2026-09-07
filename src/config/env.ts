import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  FRONTEND_URL: z.string().url("FRONTEND_URL must be a valid URL"),
  CORS_ORIGINS: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
  BODY_LIMIT: z.string().min(1).default("100kb"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
});

export type NodeEnv = z.infer<typeof envSchema>["NODE_ENV"];

function parseCorsOrigins(frontendUrl: string, extra?: string): string[] {
  const origins = new Set<string>([frontendUrl.replace(/\/$/, "")]);
  if (extra) {
    for (const origin of extra.split(",")) {
      const trimmed = origin.trim().replace(/\/$/, "");
      if (trimmed) {
        origins.add(trimmed);
      }
    }
  }
  return [...origins];
}

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === "production";
  const isTest = raw.NODE_ENV === "test";
  const corsOrigins = parseCorsOrigins(raw.FRONTEND_URL, raw.CORS_ORIGINS);
  const cookieSecure =
    raw.COOKIE_SECURE !== undefined
      ? raw.COOKIE_SECURE === "true"
      : isProduction;

  return {
    nodeEnv: raw.NODE_ENV,
    isProduction,
    isDevelopment: raw.NODE_ENV === "development",
    isTest,
    port: raw.PORT,
    host: raw.HOST,
    databaseUrl: raw.DATABASE_URL,
    betterAuth: {
      secret: raw.BETTER_AUTH_SECRET,
      url: raw.BETTER_AUTH_URL.replace(/\/$/, ""),
    },
    google: {
      clientId: raw.GOOGLE_CLIENT_ID,
      clientSecret: raw.GOOGLE_CLIENT_SECRET,
    },
    frontendUrl: raw.FRONTEND_URL.replace(/\/$/, ""),
    corsOrigins,
    logLevel:
      raw.LOG_LEVEL ??
      (isProduction ? "info" : isTest ? "silent" : "debug"),
    bodyLimit: raw.BODY_LIMIT,
    cookieSecure,
    apiPrefix: "/api/v1" as const,
    authBasePath: "/api/auth" as const,
  };
}

export type AppConfig = ReturnType<typeof loadEnv>;

export const env: AppConfig = loadEnv();
