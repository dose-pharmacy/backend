import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { financeReportingController } from "../controllers/finance-reporting/finance-reporting.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  financeDashboardQuerySchema,
  financeReportQuerySchema,
  financeTrendsQuerySchema,
} from "../validators/finance-reporting/finance-reporting.js";

/**
 * NEW, isolated Finance Reporting module.
 *
 * Read-only aggregation layer. It never mutates and is mounted at
 * `/api/v1/finance-reporting`, entirely separate from the existing
 * `/api/v1/financials` endpoints, which remain untouched.
 *
 * Access is ADMIN-only, matching the existing financials router.
 */
export const financeReportingRouter = Router();

const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

// GET /api/v1/finance-reporting/dashboard
financeReportingRouter.get(
  "/dashboard",
  ...admin,
  validate({ query: financeDashboardQuerySchema }),
  financeReportingController.getDashboard,
);

// GET /api/v1/finance-reporting/report
financeReportingRouter.get(
  "/report",
  ...admin,
  validate({ query: financeReportQuerySchema }),
  financeReportingController.getReport,
);

// GET /api/v1/finance-reporting/trends
financeReportingRouter.get(
  "/trends",
  ...admin,
  validate({ query: financeTrendsQuerySchema }),
  financeReportingController.getTrends,
);
