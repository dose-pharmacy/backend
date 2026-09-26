import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { adminController } from "../controllers/admin.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { dashboardRouter } from "./dashboard.js";
import { inventoryRouter } from "./inventory.js";
import { purchasingRouter } from "./purchasing.js";
import { posRouter } from "./pos.js";
import { financialsRouter } from "./financials.js";
import { auditTrailRouter } from "./audit.js";
import { notificationRouter } from "./notification.js";

export const v1Router = Router();

v1Router.get(
  "/admin/test",
  requireAuthenticatedUser,
  requireRole(UserRole.ADMIN),
  adminController.test,
);

v1Router.use("/dashboard", dashboardRouter);
v1Router.use("/inventory", inventoryRouter);
v1Router.use("/purchasing", purchasingRouter);
v1Router.use("/pos", posRouter);
v1Router.use("/financials", financialsRouter);
v1Router.use("/audit", auditTrailRouter);
v1Router.use("/notifications", notificationRouter);
