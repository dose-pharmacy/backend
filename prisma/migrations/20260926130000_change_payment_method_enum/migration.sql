-- Change PaymentMethod values from (CASH, CARD, DIGITAL_TRANSFER) to (CASH, MOBILE_TRANSFER, CHECK)
-- Re-maps existing data before dropping the old labels.
ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'MOBILE_TRANSFER', 'CHECK');
-- Existing CARD payments map to CHECK; DIGITAL_TRANSFER maps to MOBILE_TRANSFER.
UPDATE "sale_payment" SET "method" = 'CHECK' WHERE "method"::text = 'CARD';
UPDATE "sale_payment" SET "method" = 'MOBILE_TRANSFER' WHERE "method"::text = 'DIGITAL_TRANSFER';
UPDATE "supplier_invoice" SET "paymentMethod" = 'CHECK' WHERE "paymentMethod"::text = 'CARD';
UPDATE "supplier_invoice" SET "paymentMethod" = 'MOBILE_TRANSFER' WHERE "paymentMethod"::text = 'DIGITAL_TRANSFER';
UPDATE "payment" SET "method" = 'CHECK' WHERE "method"::text = 'CARD';
UPDATE "payment" SET "method" = 'MOBILE_TRANSFER' WHERE "method"::text = 'DIGITAL_TRANSFER';
ALTER TABLE "sale_payment" ALTER COLUMN "method" TYPE "PaymentMethod" USING "method"::text::"PaymentMethod";
ALTER TABLE "supplier_invoice" ALTER COLUMN "paymentMethod" TYPE "PaymentMethod" USING "paymentMethod"::text::"PaymentMethod";
ALTER TABLE "payment" ALTER COLUMN "method" TYPE "PaymentMethod" USING "method"::text::"PaymentMethod";
DROP TYPE "PaymentMethod_old";
