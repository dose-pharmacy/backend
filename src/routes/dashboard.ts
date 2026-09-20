import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { dashboardController } from "../controllers/dashboard/dashboard.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";

export const dashboardRouter = Router();

// All dashboard endpoints require an authenticated ADMIN session.
const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

// ---------------------------------------------------------------------------
// Summary — top-level operational KPIs
// ---------------------------------------------------------------------------
dashboardRouter.get("/summary", ...admin, dashboardController.getSummary);

// ---------------------------------------------------------------------------
// Attention — small actionable lists per category
// ---------------------------------------------------------------------------
dashboardRouter.get("/attention", ...admin, dashboardController.getAttention);

// ---------------------------------------------------------------------------
// Recent Activity — last 10 operational events (merged from 3 sources)
// ---------------------------------------------------------------------------
dashboardRouter.get(
  "/recent-activity",
  ...admin,
  dashboardController.getRecentActivity,
);
