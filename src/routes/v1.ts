import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { adminController } from "../controllers/admin.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";

export const v1Router = Router();

v1Router.get(
  "/admin/test",
  requireAuthenticatedUser,
  requireRole(UserRole.ADMIN),
  adminController.test,
);
