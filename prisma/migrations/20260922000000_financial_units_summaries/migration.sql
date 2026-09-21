-- Financial split on supplier invoices (all additive, safe defaults).
ALTER TABLE "supplier_invoice" ADD COLUMN "goodsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "additionalChargesAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
-- Historical rows had no split: goods = total, tax/charges/discount = 0.
UPDATE "supplier_invoice" SET "totalAmount" = "invoiceAmount", "goodsAmount" = "invoiceAmount";

-- Goods allocation per invoice (prevents double-invoicing received goods).
CREATE TABLE "supplier_invoice_item" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitId" TEXT,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "goodsAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_invoice_item_invoiceId_purchaseOrderItemId_key" ON "supplier_invoice_item"("invoiceId", "purchaseOrderItemId");
CREATE INDEX "supplier_invoice_item_purchaseOrderItemId_idx" ON "supplier_invoice_item"("purchaseOrderItemId");
CREATE INDEX "supplier_invoice_item_invoiceId_idx" ON "supplier_invoice_item"("invoiceId");
ALTER TABLE "supplier_invoice_item" ADD CONSTRAINT "supplier_invoice_item_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "supplier_invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_invoice_item" ADD CONSTRAINT "supplier_invoice_item_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unit consistency across purchasing (unit snapshots; null = legacy/base).
ALTER TABLE "purchase_requirement_line" ADD COLUMN "unitId" TEXT;
ALTER TABLE "purchase_requirement_line" ADD COLUMN "quantityNeededBase" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_order_item" ADD COLUMN "unitId" TEXT;
ALTER TABLE "purchase_order_item" ADD COLUMN "quantityOrderedBase" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "goods_receipt_item" ADD COLUMN "unitId" TEXT;
ALTER TABLE "stock_transaction" ADD COLUMN "unitId" TEXT;
ALTER TABLE "stock_transaction" ADD COLUMN "conversionFactor" DECIMAL(12,4);

ALTER TABLE "purchase_requirement_line" ADD CONSTRAINT "purchase_requirement_line_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_item" ADD CONSTRAINT "goods_receipt_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill base snapshots for legacy rows (null unitId = base unit, factor 1).
UPDATE "purchase_requirement_line" SET "quantityNeededBase" = "quantityNeeded" WHERE "unitId" IS NULL;
UPDATE "purchase_order_item" SET "quantityOrderedBase" = "quantityOrdered" WHERE "unitId" IS NULL;
