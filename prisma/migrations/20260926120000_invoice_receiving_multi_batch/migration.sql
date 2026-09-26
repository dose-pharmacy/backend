-- Invoice-assisted receiving.
--
-- 1) A single PO item delivery may arrive as multiple batches (Batch A = 60,
--    Batch B = 40). The old unique constraint allowed only ONE goods_receipt_item
--    per (goods receipt, purchase order item), which made that impossible.
--    Replace it with a plain lookup index.
DROP INDEX IF EXISTS "goods_receipt_item_goodsReceiptId_purchaseOrderItemId_key";
CREATE INDEX IF NOT EXISTS "goods_receipt_item_goodsReceiptId_purchaseOrderItemId_idx"
  ON "goods_receipt_item"("goodsReceiptId", "purchaseOrderItemId");

-- 2) Associate the uploaded supplier invoice document with the created invoice.
ALTER TABLE "supplier_invoice" ADD COLUMN IF NOT EXISTS "documentUrl" TEXT;
