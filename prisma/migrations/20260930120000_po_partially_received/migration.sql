-- Add PARTIALLY_RECEIVED to PurchaseOrderStatus.
--
-- Purchase order status is only a SUMMARY derived from the state of all of its
-- items. A partially received order must no longer masquerade as
-- AWAITING_DELIVERY, so the enum gains an explicit member.
--
-- Neon/Postgres does not implement `ALTER TYPE ... DROP VALUE`, and adding a
-- value cannot be used by statements in the same transaction, so the enum is
-- recreated and swapped in via the safe `text` cast (same pattern as
-- 20260924120000_remove_registered_po_status).

-- 1) Drop the default first: it must not survive the type swap and is re-added
--    after it.
ALTER TABLE "purchase_order"
ALTER COLUMN "status" DROP DEFAULT;

-- 2) Rebuild the enum with the new member and swap the column onto it.
ALTER TYPE "PurchaseOrderStatus" RENAME TO "PurchaseOrderStatus_old";

CREATE TYPE "PurchaseOrderStatus" AS ENUM
  ('AWAITING_DELIVERY', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

ALTER TABLE "purchase_order"
ALTER COLUMN "status" TYPE "PurchaseOrderStatus"
USING "status"::text::"PurchaseOrderStatus";

ALTER TABLE "purchase_order"
ALTER COLUMN "status" SET DEFAULT 'AWAITING_DELIVERY';

DROP TYPE "PurchaseOrderStatus_old";

-- 3) Backfill existing data: an AWAITING_DELIVERY order that already has
--    receiving or accepted-shortage progress on at least one item, but still
--    has outstanding quantity on some item, is PARTIALLY_RECEIVED.
--    Fully accounted orders (RECEIVED) and untouched orders are left alone.
UPDATE "purchase_order" po
SET "status" = 'PARTIALLY_RECEIVED'
WHERE po."status" = 'AWAITING_DELIVERY'
  AND EXISTS (
    SELECT 1 FROM "purchase_order_item" poi
    WHERE poi."purchaseOrderId" = po.id
      AND (poi."quantityReceived" > 0 OR poi."quantityShort" > 0)
  )
  AND EXISTS (
    SELECT 1 FROM "purchase_order_item" poi
    WHERE poi."purchaseOrderId" = po.id
      AND poi."quantityReceived" + poi."quantityShort" < poi."quantityOrdered"
  );
