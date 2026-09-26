import type { Request, Response } from "express";
import { notificationService, type NotificationListQuery } from "../../services/notification/notification.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

function asBoolean(value: unknown): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export const notificationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const input: NotificationListQuery = {
      page: typeof query.page === "string" ? Number(query.page) : undefined,
      limit: typeof query.limit === "string" ? Number(query.limit) : undefined,
      isRead: asBoolean(query.isRead),
      type: typeof query.type === "string" ? query.type as NotificationListQuery["type"] : undefined,
    };
    const userId = req.auth!.user.id;
    const { items, meta } = await notificationService.list(input, userId);
    sendSuccess(res, items, { meta });
  }),

  markRead: asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user.id;
    const data = await notificationService.markRead(req.params.id as string, userId);
    sendSuccess(res, data);
  }),

  markAllRead: asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user.id;
    await notificationService.markAllRead(userId);
    sendSuccess(res, { success: true });
  }),

  getSettings: asyncHandler(async (req: Request, res: Response) => {
    const data = await notificationService.getSettings();
    sendSuccess(res, data);
  }),

  updateSettings: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await notificationService.updateSettings(req.body, actor);
    sendSuccess(res, data);
  }),

  runPaymentReminders: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const result = await notificationService.runPaymentReminderScheduler(actor);
    sendSuccess(res, result);
  }),

  runExpiryAlerts: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const result = await notificationService.runExpiryAlertScheduler(actor);
    sendSuccess(res, result);
  }),
};