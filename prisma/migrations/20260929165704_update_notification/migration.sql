/*
  Warnings:

  - You are about to drop the column `supplierId` on the `purchase_requirement_line` table. All the data in the column will be lost.
  - The `paymentTerms` column on the `supplier_invoice` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "PurchaseOrderPaymentStatus" AS ENUM ('NOT_INVOICED', 'UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('CREDIT', 'NO_CREDIT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PAYMENT_APPROACHING_DUE', 'PAYMENT_DUE_TODAY', 'PAYMENT_OVERDUE', 'EXPIRING_WITHIN_1_YEAR', 'EXPIRING_WITHIN_6_MONTHS', 'PRODUCT_EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationEntityType" AS ENUM ('SUPPLIER_INVOICE', 'INVENTORY_BATCH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntity" ADD VALUE 'NOTIFICATION';
ALTER TYPE "AuditEntity" ADD VALUE 'NOTIFICATION_SETTINGS';

-- DropForeignKey
ALTER TABLE "purchase_requirement_line" DROP CONSTRAINT "purchase_requirement_line_supplierId_fkey";

-- DropIndex
DROP INDEX "purchase_requirement_line_supplierId_idx";

-- AlterTable
ALTER TABLE "purchase_requirement_line" DROP COLUMN "supplierId";

-- AlterTable
ALTER TABLE "supplier_invoice" ADD COLUMN     "paymentMethod" "PaymentMethod",
DROP COLUMN "paymentTerms",
ADD COLUMN     "paymentTerms" "PaymentTerms",
ALTER COLUMN "goodsAmount" DROP DEFAULT,
ALTER COLUMN "totalAmount" DROP DEFAULT;

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'WARNING',
    "entityType" "NotificationEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL,
    "paymentRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "remindBeforeDueDays" INTEGER NOT NULL DEFAULT 7,
    "remindOnDueDate" BOOLEAN NOT NULL DEFAULT true,
    "remindWhenOverdue" BOOLEAN NOT NULL DEFAULT true,
    "expiryAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertWithin6Months" BOOLEAN NOT NULL DEFAULT true,
    "alertWithin1Year" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_userId_isRead_idx" ON "notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "notification_userId_createdAt_idx" ON "notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_type_idx" ON "notification"("type");

-- CreateIndex
CREATE INDEX "notification_entityType_entityId_idx" ON "notification"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "notification_createdAt_idx" ON "notification"("createdAt");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "purchase_requirement_allocation_requirementLineId_purchaseOrder" RENAME TO "purchase_requirement_allocation_requirementLineId_purchaseO_key";
