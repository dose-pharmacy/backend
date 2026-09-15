-- CreateEnum
CREATE TYPE "StockDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('OPENING', 'PURCHASE', 'SALE', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'RETURN_IN', 'RETURN_OUT', 'EXPIRY', 'DISPOSAL', 'CORRECTION');

-- CreateTable
CREATE TABLE "product_group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultProfitMargin" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genericName" TEXT,
    "brand" TEXT,
    "sku" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "minimumStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reorderPoint" DECIMAL(14,3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "productGroupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_unit" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conversionFactor" DECIMAL(12,4) NOT NULL,
    "sellPrice" DECIMAL(12,2),
    "purchasePrice" DECIMAL(12,2),
    "isBaseUnit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "manufacturingDate" TIMESTAMP(3),
    "receivedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "purchaseCost" DECIMAL(12,2),
    "supplierReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reservedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transaction" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "transactionType" "StockTransactionType" NOT NULL,
    "direction" "StockDirection" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "balanceAfter" DECIMAL(14,3) NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_group_isActive_idx" ON "product_group"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "product_group_name_key" ON "product_group"("name");

-- CreateIndex
CREATE INDEX "product_productGroupId_idx" ON "product"("productGroupId");

-- CreateIndex
CREATE INDEX "product_name_idx" ON "product"("name");

-- CreateIndex
CREATE INDEX "product_isActive_idx" ON "product"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "product_sku_key" ON "product"("sku");

-- CreateIndex
CREATE INDEX "product_unit_productId_isBaseUnit_idx" ON "product_unit"("productId", "isBaseUnit");

-- CreateIndex
CREATE UNIQUE INDEX "product_unit_productId_name_key" ON "product_unit"("productId", "name");

-- CreateIndex
CREATE INDEX "inventory_location_isActive_idx" ON "inventory_location"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_location_name_key" ON "inventory_location"("name");

-- CreateIndex
CREATE INDEX "batch_productId_expiryDate_idx" ON "batch"("productId", "expiryDate");

-- CreateIndex
CREATE INDEX "batch_batchNumber_idx" ON "batch"("batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "batch_productId_batchNumber_key" ON "batch"("productId", "batchNumber");

-- CreateIndex
CREATE INDEX "inventory_stock_productId_idx" ON "inventory_stock"("productId");

-- CreateIndex
CREATE INDEX "inventory_stock_locationId_idx" ON "inventory_stock"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_batchId_locationId_key" ON "inventory_stock"("batchId", "locationId");

-- CreateIndex
CREATE INDEX "stock_transaction_productId_createdAt_idx" ON "stock_transaction"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_transaction_batchId_createdAt_idx" ON "stock_transaction"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_transaction_locationId_createdAt_idx" ON "stock_transaction"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_transaction_transactionType_idx" ON "stock_transaction"("transactionType");

-- CreateIndex
CREATE INDEX "stock_transaction_createdById_idx" ON "stock_transaction"("createdById");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_productGroupId_fkey" FOREIGN KEY ("productGroupId") REFERENCES "product_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_unit" ADD CONSTRAINT "product_unit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
-- Constraints that Prisma Migrate cannot express in schema.prisma
-- (added here so the database enforces the inventory invariants
-- even when application logic is bypassed).
-- ============================================================

-- A product may have exactly ONE base unit. PostgreSQL partial
-- unique index: Prisma does not support partial indexes, so it is
-- declared here and intentionally left out of schema.prisma.
CREATE UNIQUE INDEX "product_unit_single_base_idx" ON "product_unit"("productId") WHERE "isBaseUnit";

-- Conversion factors must be positive.
ALTER TABLE "product_unit" ADD CONSTRAINT "product_unit_conversion_factor_positive" CHECK ("conversionFactor" > 0);

-- The base unit of a product always has conversionFactor = 1.
ALTER TABLE "product_unit" ADD CONSTRAINT "product_unit_base_factor_one" CHECK (NOT "isBaseUnit" OR "conversionFactor" = 1);

-- Stock on hand can never be negative.
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_quantity_non_negative" CHECK ("quantity" >= 0);

ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_reserved_non_negative" CHECK ("reservedQuantity" >= 0);

-- Every movement moves a positive amount...
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_quantity_positive" CHECK ("quantity" > 0);

-- ...and never leaves a negative balance behind.
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_balance_after_non_negative" CHECK ("balanceAfter" >= 0);
