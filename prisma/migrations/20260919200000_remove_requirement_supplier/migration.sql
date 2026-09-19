-- Migration: remove_requirement_supplier
-- Removes supplierId from PurchaseRequirementLine and removes ASSIGNED from PurchaseRequirementStatus

-- Step 1: Update any ASSIGNED requirement lines to OPEN (before dropping the enum value)
UPDATE "purchase_requirement_line" SET "status" = 'OPEN' WHERE "status" = 'ASSIGNED';

-- Step 2: Update any ASSIGNED requirement headers to OPEN
UPDATE "purchase_requirement" SET "status" = 'OPEN' WHERE "status" = 'ASSIGNED';

-- Step 3: Drop the supplierId FK column from purchase_requirement_line
ALTER TABLE "purchase_requirement_line" DROP COLUMN IF EXISTS "supplier_id";

-- Step 4: Remove defaults referencing the old enum before recreating
ALTER TABLE "purchase_requirement" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "purchase_requirement_line" ALTER COLUMN "status" DROP DEFAULT;

-- Step 5: Rename old enum, create new one without ASSIGNED
ALTER TYPE "PurchaseRequirementStatus" RENAME TO "PurchaseRequirementStatus_old";
CREATE TYPE "PurchaseRequirementStatus" AS ENUM ('OPEN', 'CLOSED');

-- Step 6: Update the columns to use the new type
ALTER TABLE "purchase_requirement"
  ALTER COLUMN "status" TYPE "PurchaseRequirementStatus"
  USING "status"::text::"PurchaseRequirementStatus";

ALTER TABLE "purchase_requirement_line"
  ALTER COLUMN "status" TYPE "PurchaseRequirementStatus"
  USING "status"::text::"PurchaseRequirementStatus";

-- Step 7: Restore defaults using the new enum type
ALTER TABLE "purchase_requirement" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"PurchaseRequirementStatus";
ALTER TABLE "purchase_requirement_line" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"PurchaseRequirementStatus";

-- Step 8: Drop the old enum type
DROP TYPE "PurchaseRequirementStatus_old";
