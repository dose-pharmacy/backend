import type { Request, Response } from "express";
import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import { asyncHandler } from "../utils/async-handler.js";

export const adminController = {
  test: asyncHandler((req: Request, res: Response) => {
    if (!req.auth) {
      throw new AppError(401, ErrorCode.UNAUTHENTICATED, "Authentication required");
    }

    res.status(200).json({
      success: true,
      data: {
        message: "Admin authorization is working",
        user: {
          id: req.auth.user.id,
          email: req.auth.user.email,
          name: req.auth.user.name,
          role: req.auth.user.role,
        },
      },
    });
  }),
};
