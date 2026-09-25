-- Add customer fields to sale table for credit sales
ALTER TABLE "sale" ADD COLUMN "customerName" TEXT;
ALTER TABLE "sale" ADD COLUMN "customerPhone" TEXT;

-- Create index for customer phone lookups
CREATE INDEX "sale_customerPhone_idx" ON "sale" ("customerPhone");