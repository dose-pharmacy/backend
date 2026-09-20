import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { auditTrailController } from "../controllers/audit/audit-trail.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";
import { uuidSchema } from "../validators/inventory/common.js";
import { paginationQuerySchema } from "../validators/common.js";

export const auditTrailRouter = Router();

const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

const auditTrailQuerySchema = z
  .object({
    userId: uuidSchema.optional(),
    action: z.string().optional(),
    entity: z.string().optional(),
    entityId: uuidSchema.optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  })
  .merge(paginationQuerySchema);

auditTrailRouter.get(
  "/",
  ...admin,
  validate({ query: auditTrailQuerySchema }),
  auditTrailController.getAuditTrail,
);

auditTrailRouter.get(
  "/entity/:entity/:entityId",
  ...admin,
  validate({ params: z.object({ entity: z.string(), entityId: uuidSchema }) }),
  auditTrailController.getAuditTrailByEntity,
);

auditTrailRouter.get(
  "/user/:userId",
  ...admin,
  validate({ params: z.object({ userId: uuidSchema }) }),
  auditTrailController.getAuditTrailByUser,
);