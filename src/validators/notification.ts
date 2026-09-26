import { z } from "zod";
import { paginationQuerySchema } from "./inventory/common.js";

export const notificationTypeSchema = z.enum([
  "PAYMENT_APPROACHING_DUE",
  "PAYMENT_DUE_TODAY",
  "PAYMENT_OVERDUE",
  "EXPIRING_WITHIN_1_YEAR",
  "EXPIRING_WITHIN_6_MONTHS",
  "PRODUCT_EXPIRED",
]);

export const notificationSeveritySchema = z.enum(["INFO", "WARNING", "CRITICAL"]);

export const notificationEntityTypeSchema = z.enum(["SUPPLIER_INVOICE", "INVENTORY_BATCH"]);

export const notificationListQuerySchema = z
  .object({
    isRead: z.coerce.boolean().optional(),
    type: notificationTypeSchema.optional(),
  })
  .merge(paginationQuerySchema);

export const notificationParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createNotificationSchema = z.object({
  userId: z.string().uuid(),
  type: notificationTypeSchema,
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(1000),
  severity: notificationSeveritySchema,
  entityType: notificationEntityTypeSchema,
  entityId: z.string().uuid(),
});

export const updateNotificationSettingsSchema = z.object({
  paymentRemindersEnabled: z.boolean().optional(),
  remindBeforeDueDays: z.number().int().positive().optional(),
  remindOnDueDate: z.boolean().optional(),
  remindWhenOverdue: z.boolean().optional(),
  expiryAlertsEnabled: z.boolean().optional(),
  alertWithin6Months: z.boolean().optional(),
  alertWithin1Year: z.boolean().optional(),
});