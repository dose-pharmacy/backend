-- Add optional unit snapshot to purchase returns (null = base unit / legacy rows).
ALTER TABLE "purchase_return" ADD COLUMN "unitId" TEXT;
ALTER TABLE "purchase_return" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(14,3);
ALTER TABLE "purchase_return" ADD COLUMN "unitConversionFactor" DECIMAL(12,4);
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "purchase_return_unitId_idx" ON "purchase_return"("unitId");