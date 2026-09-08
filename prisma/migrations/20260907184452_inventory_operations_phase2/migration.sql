-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'PENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExpiryActionType" AS ENUM ('RETURN_TO_SUPPLIER', 'CLEARANCE_SALE', 'DISPOSE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockTransactionType" ADD VALUE 'RETURN_TO_SUPPLIER';
ALTER TYPE "StockTransactionType" ADD VALUE 'CLEARANCE_SALE';

-- CreateTable
CREATE TABLE "stock_transfer" (
    "id" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_item" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfer_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expiry_action" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "actionType" "ExpiryActionType" NOT NULL,
    "quantity" DECIMAL(14,3),
    "locationId" TEXT,
    "supplierId" TEXT,
    "discountPercent" DECIMAL(5,2),
    "reason" TEXT,
    "notes" TEXT,
    "performedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiry_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reorder_configuration" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minimumStockLevel" DECIMAL(14,3) NOT NULL,
    "reorderPoint" DECIMAL(14,3) NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 7,
    "reorderQuantity" DECIMAL(14,3) NOT NULL,
    "useSalesVelocity" BOOLEAN NOT NULL DEFAULT false,
    "bufferPercentage" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reorder_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transfer_fromLocationId_idx" ON "stock_transfer"("fromLocationId");

-- CreateIndex
CREATE INDEX "stock_transfer_toLocationId_idx" ON "stock_transfer"("toLocationId");

-- CreateIndex
CREATE INDEX "stock_transfer_status_idx" ON "stock_transfer"("status");

-- CreateIndex
CREATE INDEX "stock_transfer_createdById_idx" ON "stock_transfer"("createdById");

-- CreateIndex
CREATE INDEX "stock_transfer_item_transferId_idx" ON "stock_transfer_item"("transferId");

-- CreateIndex
CREATE INDEX "stock_transfer_item_productId_idx" ON "stock_transfer_item"("productId");

-- CreateIndex
CREATE INDEX "stock_transfer_item_batchId_idx" ON "stock_transfer_item"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_item_transferId_productId_batchId_key" ON "stock_transfer_item"("transferId", "productId", "batchId");

-- CreateIndex
CREATE INDEX "expiry_action_batchId_idx" ON "expiry_action"("batchId");

-- CreateIndex
CREATE INDEX "expiry_action_actionType_idx" ON "expiry_action"("actionType");

-- CreateIndex
CREATE INDEX "expiry_action_performedById_idx" ON "expiry_action"("performedById");

-- CreateIndex
CREATE UNIQUE INDEX "reorder_configuration_productId_key" ON "reorder_configuration"("productId");

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_action" ADD CONSTRAINT "expiry_action_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_action" ADD CONSTRAINT "expiry_action_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_action" ADD CONSTRAINT "expiry_action_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_configuration" ADD CONSTRAINT "reorder_configuration_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
