ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";

CREATE TYPE "PaymentMethod" AS ENUM (
  'CASH',
  'MOBILE_TRANSFER',
  'CHECK'
);

ALTER TABLE "sale_payment"
ALTER COLUMN "method" TYPE "PaymentMethod"
USING (
  CASE
    WHEN "method"::text = 'CARD' THEN 'CHECK'
    WHEN "method"::text = 'DIGITAL_TRANSFER' THEN 'MOBILE_TRANSFER'
    ELSE "method"::text
  END
)::"PaymentMethod";


ALTER TABLE "payment"
ALTER COLUMN "method" TYPE "PaymentMethod"
USING (
  CASE
    WHEN "method"::text = 'CARD' THEN 'CHECK'
    WHEN "method"::text = 'DIGITAL_TRANSFER' THEN 'MOBILE_TRANSFER'
    ELSE "method"::text
  END
)::"PaymentMethod";

DROP TYPE "PaymentMethod_old";
