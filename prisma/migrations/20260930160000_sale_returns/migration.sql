-- POS customer product returns against a completed sale.
--
-- The original sale/sale_item is historical truth and is NEVER updated by a
-- return. Sale return history is recorded separately and points at the exact
-- original SaleItem (not just productId), so the same product sold at
-- different prices in different sales stays distinguishable.
--
-- The refund is stored on sale_return itself (refundAmount/refundMethod) and
-- is deliberately NOT written into sale_payment/payment, so the original
-- sale's payment history remains unchanged for the finance module.
--
-- sale_return_item_batch records which ORIGINAL batch the returned units came
-- from, so a restockable return can restore stock to the same batch it was
-- sold from at the same location.
--
-- sale_return.idempotencyKey is a unique, nullable client-supplied key so a
-- double click / client retry returns the original return instead of creating
-- a duplicate refund and stock movement. NULL values do not collide.
ALTER TYPE "AuditEntity" ADD VALUE 'SALE_RETURN';

-- CreateTable
CREATE TABLE "sale_return" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "refundAmount" DECIMAL(12,2) NOT NULL,
    "refundMethod" "PaymentMethod" NOT NULL,
    "refundReference" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_item" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "netUnitPrice" DECIMAL(12,2) NOT NULL,
    "refundAmount" DECIMAL(12,2) NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_return_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_item_batch" (
    "id" TEXT NOT NULL,
    "saleReturnItemId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_return_item_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_returnNumber_key" ON "sale_return"("returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_idempotencyKey_key" ON "sale_return"("idempotencyKey");

-- CreateIndex
CREATE INDEX "sale_return_saleId_idx" ON "sale_return"("saleId");

-- CreateIndex
CREATE INDEX "sale_return_locationId_idx" ON "sale_return"("locationId");

-- CreateIndex
CREATE INDEX "sale_return_createdById_idx" ON "sale_return"("createdById");

-- CreateIndex
CREATE INDEX "sale_return_createdAt_idx" ON "sale_return"("createdAt");

-- CreateIndex
CREATE INDEX "sale_return_item_returnId_idx" ON "sale_return_item"("returnId");

-- CreateIndex
CREATE INDEX "sale_return_item_saleItemId_idx" ON "sale_return_item"("saleItemId");

-- CreateIndex
CREATE INDEX "sale_return_item_productId_idx" ON "sale_return_item"("productId");

-- CreateIndex
CREATE INDEX "sale_return_item_batch_batchId_idx" ON "sale_return_item_batch"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_item_batch_saleReturnItemId_batchId_key" ON "sale_return_item_batch"("saleReturnItemId", "batchId");

-- AddForeignKey
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "sale_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "sale_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item_batch" ADD CONSTRAINT "sale_return_item_batch_saleReturnItemId_fkey" FOREIGN KEY ("saleReturnItemId") REFERENCES "sale_return_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item_batch" ADD CONSTRAINT "sale_return_item_batch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

