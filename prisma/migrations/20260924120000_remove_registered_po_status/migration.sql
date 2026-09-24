-- Remove the legacy REGISTERED purchase order status.
--
-- Purchase orders are now created directly in AWAITING_DELIVERY, and the
-- "create a REGISTERED draft, then mark it awaiting delivery" flow has been
-- deleted along with its endpoint, so the REGISTERED member is obsolete and is
-- dropped from the enum.
--
-- NOTE: Neon's Postgres does not implement `ALTER TYPE ... DROP VALUE`
-- (0A000 "not implemented"), so the enum is recreated without the member and
-- swapped in via the safe `text` cast.

-- 1) Promote any leftover REGISTERED drafts. They were old "registered" orders
--    that never moved on; making them AWAITING_DELIVERY keeps them editable
--    until receiving begins, and matches how new orders are created today.
UPDATE "purchase_order"
SET "status" = 'AWAITING_DELIVERY'
WHERE "status" = 'REGISTERED';

-- 2) Drop the default first: it references the obsolete REGISTERED member and
--    must not survive the type swap (and must be re-added after it).
ALTER TABLE "purchase_order"
ALTER COLUMN "status" DROP DEFAULT;

-- 3) Rebuild the enum without REGISTERED and swap the column onto it via the
--    safe `text` cast (all remaining values are valid members of the new type).
ALTER TYPE "PurchaseOrderStatus" RENAME TO "PurchaseOrderStatus_old";

CREATE TYPE "PurchaseOrderStatus" AS ENUM
  ('AWAITING_DELIVERY', 'RECEIVED', 'CLOSED', 'CANCELLED');

ALTER TABLE "purchase_order"
ALTER COLUMN "status" TYPE "PurchaseOrderStatus"
USING "status"::text::"PurchaseOrderStatus";

-- 4) Restore the default for the first status new orders get today.
ALTER TABLE "purchase_order"
ALTER COLUMN "status" SET DEFAULT 'AWAITING_DELIVERY';

-- 5) Tidy up the temporary type.
DROP TYPE "PurchaseOrderStatus_old";
