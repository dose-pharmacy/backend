-- Purchase returns: financial linkage for finance-ready purchasing data.
--
-- 1. purchaseReturn.purchaseOrderItemId: the PO item whose received goods are
--    being returned (nullable — legacy rows stay unlinked).
-- 2. purchaseReturn.appliedToPayable: how much of debitNoteAmount was applied
--    against outstanding supplier payables at return time; the remainder is a
--    supplier refund/credit effect.
-- 3. purchaseReturn.idempotencyKey: client-supplied de-duplication key
--    (unique; multiple NULLs allowed).

ALTER TABLE "purchase_return"
  ADD COLUMN "purchaseOrderItemId" TEXT,
  ADD COLUMN "appliedToPayable" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "idempotencyKey" TEXT;

ALTER TABLE "purchase_return"
  ADD CONSTRAINT "purchase_return_purchaseOrderItemId_fkey"
  FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_item"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "purchase_return_purchaseOrderItemId_idx"
  ON "purchase_return"("purchaseOrderItemId");

CREATE UNIQUE INDEX "purchase_return_idempotencyKey_key"
  ON "purchase_return"("idempotencyKey");
