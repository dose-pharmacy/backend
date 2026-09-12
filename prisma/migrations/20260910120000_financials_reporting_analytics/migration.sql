-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'DIGITAL_TRANSFER');
CREATE TYPE "DiscountScope" AS ENUM ('ITEM', 'BILL');
CREATE TYPE "SlowMovingDefinition" AS ENUM ('DAYS_30', 'DAYS_60', 'DAYS_90', 'DAYS_180', 'CUSTOM');

-- Add genericProductId and manufacturerId to Product (nullable for backward compatibility)
ALTER TABLE "product" ADD COLUMN "genericProductId" TEXT;
ALTER TABLE "product" ADD COLUMN "manufacturerId" TEXT;

CREATE INDEX "product_genericProductId_idx" ON "product"("genericProductId");
CREATE INDEX "product_manufacturerId_idx" ON "product"("manufacturerId");

ALTER TABLE "product" ADD CONSTRAINT "product_genericProductId_fkey" FOREIGN KEY ("genericProductId") REFERENCES "generic_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product" ADD CONSTRAINT "product_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "manufacturer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add slowMovingConfiguration relation to Product (handled by SlowMovingConfiguration table)

-- CreateTable: GenericProduct
CREATE TABLE "generic_product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generic_product_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "generic_product_name_key" ON "generic_product"("name");
CREATE INDEX "generic_product_name_idx" ON "generic_product"("name");

-- CreateTable: Manufacturer
CREATE TABLE "manufacturer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactInfo" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manufacturer_name_key" ON "manufacturer"("name");
CREATE INDEX "manufacturer_isActive_idx" ON "manufacturer"("isActive");

-- CreateTable: Sale
CREATE TABLE "sale" (
    "id" TEXT NOT NULL,
    "saleNumber" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "billDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sale_saleNumber_key" ON "sale"("saleNumber");
CREATE INDEX "sale_cashierId_idx" ON "sale"("cashierId");
CREATE INDEX "sale_locationId_idx" ON "sale"("locationId");
CREATE INDEX "sale_status_idx" ON "sale"("status");
CREATE INDEX "sale_createdAt_idx" ON "sale"("createdAt");
ALTER TABLE "sale" ADD CONSTRAINT "sale_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale" ADD CONSTRAINT "sale_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: SaleLine
CREATE TABLE "sale_line" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitSold" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "quantityBaseUnits" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "itemDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_line_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sale_line_saleId_idx" ON "sale_line"("saleId");
CREATE INDEX "sale_line_productId_idx" ON "sale_line"("productId");
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: Payment
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "referenceNumber" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payment_saleId_idx" ON "payment"("saleId");
CREATE INDEX "payment_method_idx" ON "payment"("method");
ALTER TABLE "payment" ADD CONSTRAINT "payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment" ADD CONSTRAINT "payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: DiscountAuthorizationRule
CREATE TABLE "discount_authorization_rule" (
    "id" TEXT NOT NULL,
    "scope" "DiscountScope" NOT NULL,
    "maxDiscountPct" DECIMAL(5,2) NOT NULL,
    "roleRequiredAbove" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discount_authorization_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SlowMovingConfiguration
CREATE TABLE "slow_moving_configuration" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "definitionType" "SlowMovingDefinition" NOT NULL,
    "customDays" INTEGER,
    "lastSaleDate" TIMESTAMP(3),
    "daysSinceLastSale" INTEGER,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slow_moving_configuration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "slow_moving_configuration_productId_key" ON "slow_moving_configuration"("productId");
ALTER TABLE "slow_moving_configuration" ADD CONSTRAINT "slow_moving_configuration_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add sales relation to InventoryLocation
ALTER TABLE "inventory_location" ADD CONSTRAINT "inventory_location_sales_fkey" FOREIGN KEY ("id") REFERENCES "sale"("locationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add recordedBy relation to Payment (already added via recordedById FK above)
-- Payment model already has recordedById FK to User

-- Add slowMovingConfiguration relation to Product (handled by SlowMovingConfiguration table FK)