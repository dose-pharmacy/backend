import type { Request, Response } from "express";
import { auditTrailService, type AuditTrailQuery } from "../../services/audit/audit-trail.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const auditTrailController = {
  getAuditTrail: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: AuditTrailQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      userId: query.userId,
      action: query.action,
      entity: query.entity,
      entityId: query.entityId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    };
    const result = await auditTrailService.getAuditTrail(input);
    sendSuccess(res, result);
  }),

  getAuditTrailByEntity: asyncHandler(async (req: Request, res: Response) => {
    const { entity, entityId } = req.params;
    const query = req.query as Record<string, string | undefined>;
    const input: AuditTrailQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    };
    const result = await auditTrailService.getAuditTrailByEntity(entity, entityId, input);
    sendSuccess(res, result);
  }),

  getAuditTrailByUser: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const query = req.query as Record<string, string | undefined>;
    const input: AuditTrailQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    };
    const result = await auditTrailService.getAuditTrailByUser(userId, input);
    sendSuccess(res, result);
  }),
};