-- Narcotic/controlled product flag (MVP).
-- Existing products default to isNarcotic = false, so nothing breaks.
ALTER TABLE "product" ADD COLUMN "isNarcotic" BOOLEAN NOT NULL DEFAULT false;

-- The narcotic report filters on isNarcotic (often combined with productId /
-- locationId through the stock and transaction joins); a plain B-tree keeps
-- those plans cheap at this scale.
CREATE INDEX "product_isNarcotic_idx" ON "product"("isNarcotic");
