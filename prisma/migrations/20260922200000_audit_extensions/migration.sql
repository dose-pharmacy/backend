-- The AuditTrail model existed in schema.prisma but was never present in this
-- database (no prior migration created it), so this migration creates the full
-- audit structure: enum types, table, indexes and FK. Extended enum values
-- (CONFIRM / CLOSE actions, PURCHASE_REQUIREMENT entity) are included from the
-- start so business transitions can be audited without further type changes.
-- The actor column is nullable: system/background events have no user.

CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'IMPORT', 'APPROVE', 'REJECT', 'CANCEL', 'COMPLETE', 'CONFIRM', 'CLOSE');

CREATE TYPE "AuditEntity" AS ENUM ('USER', 'PRODUCT', 'BATCH', 'STOCK_TRANSACTION', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE', 'SUPPLIER_PAYMENT', 'PURCHASE_RETURN', 'SALE', 'PAYMENT', 'SUPPLIER', 'LOCATION', 'EXPIRY_ACTION', 'REORDER_CONFIG', 'DISCOUNT_AUTH_RULE', 'SLOW_MOVING_CONFIG', 'GENERIC_PRODUCT', 'MANUFACTURER', 'PURCHASE_REQUIREMENT');

-- CreateTable
CREATE TABLE "audit_trail" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entity" "AuditEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "oldData" JSONB,
    "newData" JSONB,
    "description" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_trail_userId_idx" ON "audit_trail"("userId");

-- CreateIndex
CREATE INDEX "audit_trail_entity_entityId_idx" ON "audit_trail"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_trail_action_idx" ON "audit_trail"("action");

-- CreateIndex
CREATE INDEX "audit_trail_createdAt_idx" ON "audit_trail"("createdAt");

-- AddForeignKey
ALTER TABLE "audit_trail" ADD CONSTRAINT "audit_trail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
