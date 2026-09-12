-- Refactor ProductUnit to reference a reusable master Unit, and make
-- StockTransferItem unit-aware (unitId + baseQuantity) for auditability.
--
-- The partial unique index enforcing exactly one base unit per product
-- (product_unit_single_base_idx) and the check constraints on conversion
-- factors already exist from the inventory_core migration and are preserved.

-- DropIndex
DROP INDEX "product_unit_productId_name_key";

-- DropIndex
DROP INDEX "stock_transfer_item_transferId_productId_batchId_key";

-- AlterTable
ALTER TABLE "product_unit" DROP COLUMN "name",
ADD COLUMN     "unitId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "stock_transfer_item" ADD COLUMN     "baseQuantity" DECIMAL(14,3) NOT NULL,
ADD COLUMN     "unitId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "unit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unit_isActive_idx" ON "unit"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "unit_name_key" ON "unit"("name");

-- CreateIndex
CREATE INDEX "product_unit_unitId_idx" ON "product_unit"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "product_unit_productId_unitId_key" ON "product_unit"("productId", "unitId");

-- CreateIndex
CREATE INDEX "stock_transfer_item_unitId_idx" ON "stock_transfer_item"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_item_transferId_productId_batchId_unitId_key" ON "stock_transfer_item"("transferId", "productId", "batchId", "unitId");

-- AddForeignKey
ALTER TABLE "product_unit" ADD CONSTRAINT "product_unit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;