import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { prisma } from "../database/prisma.js";
import { UserRole } from "../authorization/roles.js";

const additionalUserFields = {
  role: {
    type: "string" as const,
    required: false,
    defaultValue: UserRole.ADMIN,
    input: false,
  },
};

export const auth = betterAuth({
  appName: "Pharmacy Management System",
  baseURL: env.betterAuth.url,
  basePath: env.authBasePath,
  secret: env.betterAuth.secret,
  trustedOrigins: env.corsOrigins,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  socialProviders: {
    google: {
      clientId: env.google.clientId,
      clientSecret: env.google.clientSecret,
      prompt: "select_account",
    },
  },
  user: {
    additionalFields: additionalUserFields,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: false,
    },
  },
  rateLimit: {
    enabled: !env.isTest,
    window: 60,
    max: 20,
  },
  advanced: {
    useSecureCookies: env.cookieSecure,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: env.cookieSecure ? "none" : "lax",
      path: "/",
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          return {
            data: {
              ...user,
              role: UserRole.ADMIN,
            },
          };
        },
      },
    },
  },
  logger: {
    disabled: env.isTest,
    level: env.isProduction ? "error" : "warn",
    log(level, message, ...args) {
      if (level === "error") {
        logger.error({ args }, message);
        return;
      }
      logger.warn({ args }, message);
    },
  },
});

export type AuthInstance = typeof auth;
