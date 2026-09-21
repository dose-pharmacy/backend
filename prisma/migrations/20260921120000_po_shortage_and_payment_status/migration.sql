-- Accepted shortage on purchase order items.
-- Existing rows keep quantityShort = 0 (nothing was accepted as short before
-- this feature existed) and shortReason = NULL.
ALTER TABLE "purchase_order_item" ADD COLUMN "quantityShort" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_order_item" ADD COLUMN "shortReason" TEXT;

-- Index supporting PO -> invoices aggregation and payment-status filtering.
CREATE INDEX "supplier_invoice_purchaseOrderId_idx" ON "supplier_invoice"("purchaseOrderId");
