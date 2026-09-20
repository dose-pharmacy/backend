-- Migration: requirement_allocation
-- Extends PurchaseRequirementStatus with the partial/full fulfillment states and adds
-- purchase_requirement_allocation: one row per (requirement line, purchase-order item)
-- link describing how much of a requirement line that PO item fulfills.
--
-- A requirement line can be filled by many PO items (multi-supplier / partial ordering).
-- An allocation is only "active" while its purchase order is not CANCELLED, so cancelling
-- a PO releases quantity without deleting the audit trail.
--
-- Column names are camelCase to match the rest of the schema (Prisma field names without
-- an explicit @map).

-- Step 1: extend the requirement status enum. (The new values are not used as literals
-- inside this transaction, which PostgreSQL requires.)
ALTER TYPE "PurchaseRequirementStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_FULFILLED';
ALTER TYPE "PurchaseRequirementStatus" ADD VALUE IF NOT EXISTS 'FULFILLED';

-- Step 2: allocation table.
CREATE TABLE IF NOT EXISTS "purchase_requirement_allocation" (
    "id" TEXT NOT NULL,
    "requirementLineId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantityAllocated" DECIMAL(14,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "purchase_requirement_allocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "purchase_requirement_allocation_requirementLineId_purchaseOrderItemId_key"
    ON "purchase_requirement_allocation"("requirementLineId", "purchaseOrderItemId");
CREATE INDEX IF NOT EXISTS "purchase_requirement_allocation_requirementLineId_idx"
    ON "purchase_requirement_allocation"("requirementLineId");
CREATE INDEX IF NOT EXISTS "purchase_requirement_allocation_purchaseOrderItemId_idx"
    ON "purchase_requirement_allocation"("purchaseOrderItemId");

ALTER TABLE "purchase_requirement_allocation"
    DROP CONSTRAINT IF EXISTS "purchase_requirement_allocation_requirementLineId_fkey";
ALTER TABLE "purchase_requirement_allocation"
    ADD CONSTRAINT "purchase_requirement_allocation_requirementLineId_fkey"
    FOREIGN KEY ("requirementLineId") REFERENCES "purchase_requirement_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_requirement_allocation"
    DROP CONSTRAINT IF EXISTS "purchase_requirement_allocation_purchaseOrderItemId_fkey";
ALTER TABLE "purchase_requirement_allocation"
    ADD CONSTRAINT "purchase_requirement_allocation_purchaseOrderItemId_fkey"
    FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 3: backfill allocations for existing PO items already linked to a requirement line
-- so derived quantities stay accurate for pre-existing data. The source table is aliased
-- so its columns are not shadowed by the INSERT target's column names.
INSERT INTO "purchase_requirement_allocation" (
    "id", "requirementLineId", "purchaseOrderItemId", "quantityAllocated", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    poi."requirementLineId",
    poi."id",
    poi."quantityOrdered",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "purchase_order_item" AS poi
WHERE poi."requirementLineId" IS NOT NULL
ON CONFLICT ("requirementLineId", "purchaseOrderItemId") DO NOTHING;
