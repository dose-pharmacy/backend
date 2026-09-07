import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler } from "express";
import { auth } from "../auth/auth.js";
import { hasRequiredRole, type UserRole } from "../authorization/roles.js";
import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import { logger } from "../config/logger.js";
import {
  toAuthenticatedUser,
  userRepository,
} from "../repositories/user.repository.js";
import { asyncHandler } from "../utils/async-handler.js";

export const requireAuthenticatedUser = asyncHandler(async (req, _res, next) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    throw new AppError(
      401,
      ErrorCode.UNAUTHENTICATED,
      "Authentication required",
    );
  }

  const user = await userRepository.findById(session.user.id);
  if (!user) {
    logger.warn(
      { sessionUserId: session.user.id },
      "Valid session found but user does not exist or has an invalid role in the database",
    );
    throw new AppError(
      401,
      ErrorCode.UNAUTHENTICATED,
      "Authentication required",
    );
  }

  req.auth = {
    user: toAuthenticatedUser(user),
    session: {
      id: session.session.id,
      userId: session.session.userId,
      expiresAt: session.session.expiresAt,
    },
  };

  next();
});

export function requireRole(...allowedRoles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const authContext = req.auth;
    if (!authContext) {
      next(
        new AppError(
          401,
          ErrorCode.UNAUTHENTICATED,
          "Authentication required",
        ),
      );
      return;
    }

    if (!hasRequiredRole(authContext.user.role, allowedRoles)) {
      logger.warn(
        {
          userId: authContext.user.id,
          role: authContext.user.role,
          allowedRoles,
          path: req.path,
        },
        "Authorization denied",
      );
      next(
        new AppError(
          403,
          ErrorCode.FORBIDDEN,
          "Insufficient permissions",
        ),
      );
      return;
    }

    next();
  };
}

export const requireAdmin = requireRole("ADMIN");
