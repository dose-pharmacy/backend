import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { notificationController } from "../controllers/notification/notification.controller.js";
import { requireAuthenticatedUser, requireRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  notificationListQuerySchema,
  notificationParamsSchema,
  updateNotificationSettingsSchema,
} from "../validators/notification.js";

export const notificationRouter = Router();

// All notification endpoints require authenticated user
const authenticated = [requireAuthenticatedUser] as const;

// Admin-only for settings and manual scheduler triggers
const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

// ---------------------------------------------------------------------------
// Notifications (user-specific)
// ---------------------------------------------------------------------------
notificationRouter.get(
  "/",
  ...authenticated,
  validate({ query: notificationListQuerySchema }),
  notificationController.list,
);

notificationRouter.patch(
  "/:id/read",
  ...authenticated,
  validate({ params: notificationParamsSchema }),
  notificationController.markRead,
);

notificationRouter.patch(
  "/read-all",
  ...authenticated,
  notificationController.markAllRead,
);

// ---------------------------------------------------------------------------
// Notification Settings (ADMIN only)
// ---------------------------------------------------------------------------
notificationRouter.get(
  "/settings",
  ...admin,
  notificationController.getSettings,
);

notificationRouter.patch(
  "/settings",
  ...admin,
  validate({ body: updateNotificationSettingsSchema }),
  notificationController.updateSettings,
);

// ---------------------------------------------------------------------------
// Manual Scheduler Triggers (ADMIN only)
// ---------------------------------------------------------------------------
notificationRouter.post(
  "/run/payment-reminders",
  ...admin,
  notificationController.runPaymentReminders,
);

notificationRouter.post(
  "/run/expiry-alerts",
  ...admin,
  notificationController.runExpiryAlerts,
);