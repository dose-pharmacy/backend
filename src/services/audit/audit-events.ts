import { AuditAction, AuditEntity, Prisma } from "@prisma/client";
import { logger } from "../../config/logger.js";
import { prisma } from "../../database/prisma.js";
import type { DbClient } from "../../services/purchasing/requirement.service.js";

/**
 * ============================================================================
 * Audit event catalogue
 * ============================================================================
 *
 * Central constants for every audited business event. Naming convention:
 * `ENTITY_ACTION` (e.g. GOODS_RECEIPT_CONFIRMED). The `action` and `entity`
 * columns reuse the existing AuditAction/AuditEntity enums so the generic
 * audit read API keeps filtering natively; the `description` column carries
 * the composite event name for exact-event queries.
 *
 * No separate per-domain audit tables and no duplicated events: nested
 * helpers (stock movements, batch updates) are deliberately NOT audited —
 * StockTransaction is already the detailed inventory ledger.
 */
export const AuditEvent = {
  PRODUCT_CREATED: "PRODUCT_CREATED",
  PRODUCT_UPDATED: "PRODUCT_UPDATED",
  PRODUCT_DEACTIVATED: "PRODUCT_DEACTIVATED",

  PURCHASE_REQUIREMENT_CREATED: "PURCHASE_REQUIREMENT_CREATED",
  PURCHASE_REQUIREMENT_UPDATED: "PURCHASE_REQUIREMENT_UPDATED",
  PURCHASE_REQUIREMENT_CLOSED: "PURCHASE_REQUIREMENT_CLOSED",

  PURCHASE_ORDER_CREATED: "PURCHASE_ORDER_CREATED",
  PURCHASE_ORDER_UPDATED: "PURCHASE_ORDER_UPDATED",
  PURCHASE_ORDER_CANCELLED: "PURCHASE_ORDER_CANCELLED",
  PURCHASE_ORDER_MARKED_AWAITING_DELIVERY: "PURCHASE_ORDER_MARKED_AWAITING_DELIVERY",
  PURCHASE_ORDER_CLOSED: "PURCHASE_ORDER_CLOSED",

  GOODS_RECEIPT_CREATED: "GOODS_RECEIPT_CREATED",
  GOODS_RECEIPT_RESOLVED: "GOODS_RECEIPT_RESOLVED",
  GOODS_RECEIPT_CONFIRMED: "GOODS_RECEIPT_CONFIRMED",
  GOODS_RECEIPT_DELETED: "GOODS_RECEIPT_DELETED",

  SUPPLIER_INVOICE_CREATED: "SUPPLIER_INVOICE_CREATED",
  SUPPLIER_INVOICE_UPDATED: "SUPPLIER_INVOICE_UPDATED",
  SUPPLIER_INVOICE_DELETED: "SUPPLIER_INVOICE_DELETED",
  SUPPLIER_PAYMENT_RECORDED: "SUPPLIER_PAYMENT_RECORDED",

  PURCHASE_RETURN_CREATED: "PURCHASE_RETURN_CREATED",

  SALE_COMPLETED: "SALE_COMPLETED",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",

  STOCK_ADJUSTMENT_CREATED: "STOCK_ADJUSTMENT_CREATED",
} as const;

export type AuditEventName = (typeof AuditEvent)[keyof typeof AuditEvent];

/** Action/entity pairing per event so callers can't drift from the catalogue. */
const EVENT_META: Record<AuditEventName, { action: AuditAction; entity: AuditEntity }> = {
  PRODUCT_CREATED: { action: AuditAction.CREATE, entity: AuditEntity.PRODUCT },
  PRODUCT_UPDATED: { action: AuditAction.UPDATE, entity: AuditEntity.PRODUCT },
  PRODUCT_DEACTIVATED: { action: AuditAction.UPDATE, entity: AuditEntity.PRODUCT },

  PURCHASE_REQUIREMENT_CREATED: {
    action: AuditAction.CREATE,
    entity: AuditEntity.PURCHASE_REQUIREMENT,
  },
  PURCHASE_REQUIREMENT_UPDATED: {
    action: AuditAction.UPDATE,
    entity: AuditEntity.PURCHASE_REQUIREMENT,
  },
  PURCHASE_REQUIREMENT_CLOSED: {
    action: AuditAction.UPDATE,
    entity: AuditEntity.PURCHASE_REQUIREMENT,
  },

  PURCHASE_ORDER_CREATED: { action: AuditAction.CREATE, entity: AuditEntity.PURCHASE_ORDER },
  PURCHASE_ORDER_UPDATED: { action: AuditAction.UPDATE, entity: AuditEntity.PURCHASE_ORDER },
  PURCHASE_ORDER_CANCELLED: { action: AuditAction.UPDATE, entity: AuditEntity.PURCHASE_ORDER },
  PURCHASE_ORDER_MARKED_AWAITING_DELIVERY: {
    action: AuditAction.UPDATE,
    entity: AuditEntity.PURCHASE_ORDER,
  },
  PURCHASE_ORDER_CLOSED: { action: AuditAction.UPDATE, entity: AuditEntity.PURCHASE_ORDER },

  GOODS_RECEIPT_CREATED: { action: AuditAction.CREATE, entity: AuditEntity.GOODS_RECEIPT },
  GOODS_RECEIPT_RESOLVED: { action: AuditAction.UPDATE, entity: AuditEntity.GOODS_RECEIPT },
  GOODS_RECEIPT_CONFIRMED: { action: AuditAction.CONFIRM, entity: AuditEntity.GOODS_RECEIPT },
  GOODS_RECEIPT_DELETED: { action: AuditAction.DELETE, entity: AuditEntity.GOODS_RECEIPT },

  SUPPLIER_INVOICE_CREATED: { action: AuditAction.CREATE, entity: AuditEntity.SUPPLIER_INVOICE },
  SUPPLIER_INVOICE_UPDATED: { action: AuditAction.UPDATE, entity: AuditEntity.SUPPLIER_INVOICE },
  SUPPLIER_INVOICE_DELETED: { action: AuditAction.DELETE, entity: AuditEntity.SUPPLIER_INVOICE },
  SUPPLIER_PAYMENT_RECORDED: { action: AuditAction.CREATE, entity: AuditEntity.SUPPLIER_PAYMENT },

  PURCHASE_RETURN_CREATED: { action: AuditAction.CREATE, entity: AuditEntity.PURCHASE_RETURN },

  SALE_COMPLETED: { action: AuditAction.CREATE, entity: AuditEntity.SALE },
  PAYMENT_RECEIVED: { action: AuditAction.CREATE, entity: AuditEntity.PAYMENT },

  STOCK_ADJUSTMENT_CREATED: { action: AuditAction.CREATE, entity: AuditEntity.STOCK_TRANSACTION },
};

/**
 * Writes one audit record. THE transaction-safety contract:
 *
 * - Pass `db` = the caller's `tx` (Prisma.TransactionClient) to write the audit
 *   row INSIDE the business transaction — if it rolls back, the audit row
 *   disappears with it. This is required for every event that accompanies a
 *   state change (GR confirm, payments, returns, sale completion...).
 * - Omit `db` (or pass nothing) to write on the shared client AFTER the
 *   business mutation has already committed (only for flows that do not have
 *   a wrapping transaction, e.g. simple product updates).
 *
 * The actor is always the backend-authenticated user id — client-supplied
 * actor fields are never trusted. Never throws into the business flow unless
 * the caller is inside a transaction (where aborting is correct); best-effort
 * logging failures outside transactions are logged, not raised, so an audit
 * hiccup cannot take down an already-committed business operation.
 */
export async function recordAuditEvent(
  params: {
    event: AuditEventName;
    entityId: string | null;
    actorId: string | null;
    metadata?: Prisma.InputJsonValue;
    description?: string;
  },
  db: DbClient = prisma,
): Promise<void> {
  const meta = EVENT_META[params.event];
  if (!meta) {
    // Programming error: an event name missing from EVENT_META.
    throw new Error(`Unknown audit event: ${params.event as string}`);
  }

  try {
    await db.auditTrail.create({
      data: {
        userId: params.actorId,
        action: meta.action,
        entity: meta.entity,
        entityId: params.entityId ?? "",
        oldData: Prisma.JsonNull,
        newData: params.metadata ?? Prisma.JsonNull,
        description: params.description ?? params.event,
      },
    });
  } catch (error) {
    // Inside a transaction: let the rollback happen — audit consistency is
    // the whole point. Outside: swallow so committed business state survives.
    if (db !== prisma) {
      throw error;
    }
    logger.error({ err: error, event: params.event }, "Audit write failed (non-transactional)");
  }
}
