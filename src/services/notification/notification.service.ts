import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { addUtcDays, startOfTodayUtc } from "../../utils/date-time.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { AppError } from "../../errors/app-error.js";
import { websocketService } from "../websocket/websocket.service.js";
import { UserRole } from "../../authorization/roles.js";

export type NotificationType =
  | "PAYMENT_APPROACHING_DUE"
  | "PAYMENT_DUE_TODAY"
  | "PAYMENT_OVERDUE"
  | "EXPIRING_WITHIN_1_YEAR"
  | "EXPIRING_WITHIN_6_MONTHS"
  | "PRODUCT_EXPIRED";

export type NotificationSeverity = "INFO" | "WARNING" | "CRITICAL";

export type NotificationEntityType = "SUPPLIER_INVOICE" | "INVENTORY_BATCH";

export type NotificationListQuery = PageQuery & {
  isRead?: boolean;
  type?: NotificationType;
};

export type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  severity: NotificationSeverity;
  entityType: NotificationEntityType;
  entityId: string;
};

/** Unique key for deduplicating scheduled notifications */
function _makeDedupeKey(
  type: NotificationType,
  entityType: NotificationEntityType,
  entityId: string,
): string {
  return `${type}:${entityType}:${entityId}`;
}

export const notificationService = {
  /**
   * Creates a notification for a specific user.
   * Returns the created notification or null if a duplicate was prevented.
   */
  async create(
    input: CreateNotificationInput,
    _actor?: Pick<AuthenticatedUser, "id">,
  ) {
    // const dedupeKey = makeDedupeKey(input.type, input.entityType, input.entityId);

    // Check for existing unread notification with same dedupe key
    const existing = await prisma.notification.findFirst({
      where: {
        userId: input.userId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        isRead: false,
      },
    });

    if (existing) {
      return null; // Duplicate prevented
    }

    const notification = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    });

    // Emit WebSocket event if connected
    await this.emitNotificationEvent(notification);

    return notification;
  },

  /**
   * Creates notifications for multiple users (e.g., all ADMIN/MANAGER users).
   * Uses the same deduplication logic per user.
   */
  async createForUsers(
    userIds: string[],
    input: Omit<CreateNotificationInput, "userId">,
    actor?: Pick<AuthenticatedUser, "id">,
  ) {
    const results = await Promise.all(
      userIds.map((userId) =>
        this.create({ ...input, userId }, actor).then((n) => ({ userId, notification: n })),
      ),
    );
    return results.filter((r) => r.notification !== null);
  },

  /**
   * Gets the notification settings (singleton).
   */
  async getSettings() {
    let settings = await prisma.notificationSettings.findFirst();
    if (!settings) {
      // Create default settings
      settings = await prisma.notificationSettings.create({
        data: {
          paymentRemindersEnabled: true,
          remindBeforeDueDays: 7,
          remindOnDueDate: true,
          remindWhenOverdue: true,
          expiryAlertsEnabled: true,
          alertWithin6Months: true,
          alertWithin1Year: true,
        },
      });
    }
    return settings;
  },

  /**
   * Updates the notification settings.
   */
  async updateSettings(
    input: Partial<{
      paymentRemindersEnabled: boolean;
      remindBeforeDueDays: number;
      remindOnDueDate: boolean;
      remindWhenOverdue: boolean;
      expiryAlertsEnabled: boolean;
      alertWithin6Months: boolean;
      alertWithin1Year: boolean;
    }>,
    _actor?: Pick<AuthenticatedUser, "id">,
  ) {
    let settings = await prisma.notificationSettings.findFirst();
    if (!settings) {
      settings = await prisma.notificationSettings.create({
        data: {
          ...input,
        } as Record<string, unknown>,
      });
    } else {
      settings = await prisma.notificationSettings.update({
        where: { id: settings.id },
        data: input,
      });
    }
    return settings;
  },

  /**
   * Lists notifications for the current user with pagination and filtering.
   */
  async list(query: NotificationListQuery, userId: string) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.isRead !== undefined ? { isRead: query.isRead } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total, unreadCount] = await prisma.$transaction([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit), unreadCount };
  },

  /**
   * Marks a notification as read.
   */
  async markRead(id: string, userId: string) {
    const notification = await prisma.notification.findUnique({
      where: { id },
      select: { id: true, userId: true, isRead: true },
    });

    if (!notification) {
      throw new AppError(404, ErrorCode.NOT_FOUND, "Notification not found");
    }
    if (notification.userId !== userId) {
      throw new AppError(403, ErrorCode.FORBIDDEN, "Cannot access another user's notification");
    }
    if (notification.isRead) {
      return notification;
    }

    return prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  },

  /**
   * Marks all notifications as read for the current user.
   */
  async markAllRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  },

  /**
   * Emits a WebSocket event for real-time notification delivery.
   * Sends to users based on their roles and the notification type.
   */
  async emitNotificationEvent(notification: {
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    severity: NotificationSeverity;
    entityType: NotificationEntityType;
    entityId: string;
    createdAt: Date;
  }) {
    // Determine which roles should receive this notification
    let roles: UserRole[] = [];
    if (notification.type.startsWith("PAYMENT_")) {
      roles = [UserRole.ADMIN, UserRole.MANAGER];
    } else if (notification.type.startsWith("EXPIRING_") || notification.type === "PRODUCT_EXPIRED") {
      roles = [UserRole.ADMIN, UserRole.INVENTORY_MANAGER, UserRole.MANAGER];
    }

    // Find users with these roles
    const users = await prisma.user.findMany({
      where: { role: { in: roles } },
      select: { id: true },
    });

    // Send to each user
    for (const user of users) {
      websocketService.sendNotification(user.id, notification);
    }
  },

  /**
   * Finds all supplier invoices that need payment reminders based on settings.
   */
  async findInvoicesNeedingReminders() {
    const settings = await this.getSettings();

    if (!settings.paymentRemindersEnabled) {
      return [];
    }

    const today = startOfTodayUtc();
    const remindBeforeDate = addUtcDays(today, settings.remindBeforeDueDays);

    // Find CREDIT invoices with outstanding balance > 0
    // We need to check three reminder stages:
    // 1. APPROACHING_DUE: dueDate is within remindBeforeDueDays (but not today or past)
    // 2. DUE_TODAY: dueDate is today
    // 3. OVERDUE: dueDate is in the past

    const invoices = await prisma.supplierInvoice.findMany({
      where: {
        paymentTerms: "CREDIT",
        dueDate: { not: null },
        outstandingBalance: { gt: 0 },
        status: { in: ["OPEN", "PARTIALLY_PAID"] },
      },
      include: {
        supplier: { select: { id: true, name: true } },
      },
    });

    const results: Array<{
      invoice: typeof invoices[0];
      reminderType: "APPROACHING_DUE" | "DUE_TODAY" | "OVERDUE";
    }> = [];

    for (const invoice of invoices) {
      if (!invoice.dueDate) continue;

      const dueDate = new Date(invoice.dueDate);
      const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const remindBeforeOnly = new Date(remindBeforeDate.getFullYear(), remindBeforeDate.getMonth(), remindBeforeDate.getDate());

      // OVERDUE: dueDate < today
      if (dueDateOnly < todayOnly) {
        if (settings.remindWhenOverdue) {
          results.push({ invoice, reminderType: "OVERDUE" });
        }
        continue;
      }

      // DUE_TODAY: dueDate === today
      if (dueDateOnly.getTime() === todayOnly.getTime()) {
        if (settings.remindOnDueDate) {
          results.push({ invoice, reminderType: "DUE_TODAY" });
        }
        continue;
      }

      // APPROACHING_DUE: dueDate <= remindBeforeDate AND dueDate > today
      if (dueDateOnly <= remindBeforeOnly && dueDateOnly > todayOnly) {
        results.push({ invoice, reminderType: "APPROACHING_DUE" });
      }
    }

    return results;
  },

  /**
   * Finds all batches that need expiry alerts based on settings.
   */
  async findBatchesNeedingExpiryAlerts() {
    const settings = await this.getSettings();

    if (!settings.expiryAlertsEnabled) {
      return [];
    }

    const today = startOfTodayUtc();
    const sixMonthsFromNow = addUtcDays(today, 180); // ~6 months
    const oneYearFromNow = addUtcDays(today, 365); // ~1 year

    type BatchWithDetails = {
  id: string;
  productId: string;
  batchNumber: string;
  expiryDate: Date;
  product: { id: string; name: string; sku: string };
  stock: Array<{ quantity: Prisma.Decimal }>;
};

const batches = await prisma.batch.findMany({
      where: {
        // Only batches with positive stock
        stock: {
          some: { quantity: { gt: 0 } },
        },
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        stock: { where: { quantity: { gt: 0 } }, select: { quantity: true } },
      },
    }) as unknown as BatchWithDetails[];

    const results: Array<{
      batch: BatchWithDetails;
      alertType: "EXPIRING_WITHIN_1_YEAR" | "EXPIRING_WITHIN_6_MONTHS" | "PRODUCT_EXPIRED";
    }> = [];

    for (const batch of batches) {
      if (!batch.expiryDate) continue;

      const expiryDate = new Date(batch.expiryDate);
      const expiryDateOnly = new Date(expiryDate.getFullYear(), expiryDate.getMonth(), expiryDate.getDate());
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const sixMonthsOnly = new Date(sixMonthsFromNow.getFullYear(), sixMonthsFromNow.getMonth(), sixMonthsFromNow.getDate());
      const oneYearOnly = new Date(oneYearFromNow.getFullYear(), oneYearFromNow.getMonth(), oneYearFromNow.getDate());

      // PRODUCT_EXPIRED: expiryDate < today
      if (expiryDateOnly < todayOnly) {
        results.push({ batch, alertType: "PRODUCT_EXPIRED" });
        continue;
      }

      // EXPIRING_WITHIN_6_MONTHS: expiryDate <= 6 months AND > today
      if (expiryDateOnly <= sixMonthsOnly && expiryDateOnly > todayOnly) {
        if (settings.alertWithin6Months) {
          results.push({ batch, alertType: "EXPIRING_WITHIN_6_MONTHS" });
        }
        continue;
      }

      // EXPIRING_WITHIN_1_YEAR: expiryDate <= 1 year AND > 6 months
      if (expiryDateOnly <= oneYearOnly && expiryDateOnly > sixMonthsOnly) {
        if (settings.alertWithin1Year) {
          results.push({ batch, alertType: "EXPIRING_WITHIN_1_YEAR" });
        }
        continue;
      }
    }

    return results;
  },

  /**
   * Runs the payment reminder scheduler.
   * Creates notifications for invoices needing reminders.
   */
  async runPaymentReminderScheduler(actor?: Pick<AuthenticatedUser, "id">) {
    const invoicesNeedingReminders = await this.findInvoicesNeedingReminders();

    if (invoicesNeedingReminders.length === 0) {
      return { created: 0, skipped: 0 };
    }

    // Get users who should receive payment reminders (ADMIN, MANAGER)
    const recipientUsers = await prisma.user.findMany({
      where: {
        role: { in: ["ADMIN", "MANAGER"] },
      },
      select: { id: true },
    });

    if (recipientUsers.length === 0) {
      return { created: 0, skipped: invoicesNeedingReminders.length };
    }

    let created = 0;
    let skipped = 0;

    for (const { invoice, reminderType } of invoicesNeedingReminders) {
      let type: NotificationType;
      let title: string;
      let message: string;
      let severity: NotificationSeverity;

      switch (reminderType) {
        case "APPROACHING_DUE":
          type = "PAYMENT_APPROACHING_DUE";
          title = "Supplier Payment Approaching Due";
          severity = "WARNING";
          break;
        case "DUE_TODAY":
          type = "PAYMENT_DUE_TODAY";
          title = "Supplier Payment Due Today";
          severity = "WARNING";
          break;
        case "OVERDUE":
          type = "PAYMENT_OVERDUE";
          title = "Supplier Payment Overdue";
          severity = "CRITICAL";
          break;
      }

      const daysOverdue = reminderType === "OVERDUE"
        ? Math.ceil((startOfTodayUtc().getTime() - new Date(invoice.dueDate!).getTime()) / (1000 * 60 * 60 * 24))
        : undefined;

      if (reminderType === "APPROACHING_DUE") {
        const daysUntilDue = Math.ceil((new Date(invoice.dueDate!).getTime() - startOfTodayUtc().getTime()) / (1000 * 60 * 60 * 24));
        message = `Supplier payment of ${invoice.outstandingBalance.toLocaleString()} ETB is due in ${daysUntilDue} days to ${invoice.supplier.name}.`;
      } else if (reminderType === "DUE_TODAY") {
        message = `Supplier payment of ${invoice.outstandingBalance.toLocaleString()} ETB is due today to ${invoice.supplier.name}.`;
      } else {
        message = `Supplier payment of ${invoice.outstandingBalance.toLocaleString()} ETB is overdue by ${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} to ${invoice.supplier.name}.`;
      }

      for (const user of recipientUsers) {
        const result = await this.create(
          {
            userId: user.id,
            type,
            title,
            message,
            severity,
            entityType: "SUPPLIER_INVOICE",
            entityId: invoice.id,
          },
          actor,
        );
        if (result) created++;
        else skipped++;
      }
    }

    return { created, skipped };
  },

  /**
   * Runs the expiry alert scheduler.
   * Creates notifications for batches needing expiry alerts.
   */
  async runExpiryAlertScheduler(actor?: Pick<AuthenticatedUser, "id">) {
    const batchesNeedingAlerts = await this.findBatchesNeedingExpiryAlerts();

    if (batchesNeedingAlerts.length === 0) {
      return { created: 0, skipped: 0 };
    }

    // Get users who should receive expiry alerts (ADMIN, INVENTORY_MANAGER, MANAGER)
    const recipientUsers = await prisma.user.findMany({
      where: {
        role: { in: ["ADMIN", "INVENTORY_MANAGER", "MANAGER"] },
      },
      select: { id: true },
    });

    if (recipientUsers.length === 0) {
      return { created: 0, skipped: batchesNeedingAlerts.length };
    }

    let created = 0;
    let skipped = 0;

    for (const { batch, alertType } of batchesNeedingAlerts) {
      let type: NotificationType;
      let title: string;
      let severity: NotificationSeverity;

      switch (alertType) {
        case "EXPIRING_WITHIN_1_YEAR":
          type = "EXPIRING_WITHIN_1_YEAR";
          title = "Product Expiring Within 1 Year";
          severity = "INFO";
          break;
        case "EXPIRING_WITHIN_6_MONTHS":
          type = "EXPIRING_WITHIN_6_MONTHS";
          title = "Product Expiring Within 6 Months";
          severity = "WARNING";
          break;
        case "PRODUCT_EXPIRED":
          type = "PRODUCT_EXPIRED";
          title = "Product Expired";
          severity = "CRITICAL";
          break;
      }

      const expiryDate = batch.expiryDate ? new Date(batch.expiryDate).toISOString().split("T")[0] : "unknown";
      const totalStock = batch.stock.reduce((sum, s) => sum + s.quantity.toNumber(), 0);

      const message = `${batch.product.name} batch ${batch.batchNumber} (${totalStock.toLocaleString()} units) ${alertType === "PRODUCT_EXPIRED" ? "expired on" : "expires on"} ${expiryDate}.`;

      for (const user of recipientUsers) {
        const result = await this.create(
          {
            userId: user.id,
            type,
            title,
            message,
            severity,
            entityType: "INVENTORY_BATCH",
            entityId: batch.id,
          },
          actor,
        );
        if (result) created++;
        else skipped++;
      }
    }

    return { created, skipped };
  },
};