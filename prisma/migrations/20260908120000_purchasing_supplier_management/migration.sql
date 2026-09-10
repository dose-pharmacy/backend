-- CreateEnum
CREATE TYPE "PurchaseRequirementStatus" AS ENUM ('OPEN', 'ASSIGNED', 'CLOSED');
CREATE TYPE "PurchaseRequirementReason" AS ENUM ('LOW_STOCK', 'REORDER_ALERT', 'MANUAL');
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('REGISTERED', 'AWAITING_DELIVERY', 'RECEIVED', 'CLOSED', 'CANCELLED');
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('MATCHED', 'DISCREPANCY', 'RESOLVED');
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID');
CREATE TYPE "PurchaseReturnReason" AS ENUM ('EXPIRED', 'DAMAGED', 'INCORRECT_DELIVERY');

-- CreateTable: Supplier (must be first for FK references)
CREATE TABLE "supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "paymentTerms" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_name_key" ON "supplier"("name");
CREATE INDEX "supplier_isActive_idx" ON "supplier"("isActive");

-- Add supplierId to batch (nullable, for Phase 3) - AFTER supplier table exists
ALTER TABLE "batch" ADD COLUMN "supplierId" TEXT;
CREATE INDEX "batch_supplierId_idx" ON "batch"("supplierId");
ALTER TABLE "batch" ADD CONSTRAINT "batch_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add supplier relation to expiry_action (supplierId already exists as String, add FK)
ALTER TABLE "expiry_action" ADD CONSTRAINT "expiry_action_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: PurchaseRequirement
CREATE TABLE "purchase_requirement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PurchaseRequirementStatus" NOT NULL DEFAULT 'OPEN',
    "requiredBy" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_requirement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_requirement_reference_key" ON "purchase_requirement"("reference");
CREATE INDEX "purchase_requirement_status_idx" ON "purchase_requirement"("status");
CREATE INDEX "purchase_requirement_createdById_idx" ON "purchase_requirement"("createdById");
ALTER TABLE "purchase_requirement" ADD CONSTRAINT "purchase_requirement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: PurchaseRequirementLine
CREATE TABLE "purchase_requirement_line" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantityNeeded" DECIMAL(14,3) NOT NULL,
    "quantityDelivered" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reasonCode" "PurchaseRequirementReason",
    "supplierId" TEXT,
    "status" "PurchaseRequirementStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_requirement_line_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_requirement_line_requirementId_productId_key" ON "purchase_requirement_line"("requirementId", "productId");
CREATE INDEX "purchase_requirement_line_productId_idx" ON "purchase_requirement_line"("productId");
CREATE INDEX "purchase_requirement_line_supplierId_idx" ON "purchase_requirement_line"("supplierId");
ALTER TABLE "purchase_requirement_line" ADD CONSTRAINT "purchase_requirement_line_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "purchase_requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_requirement_line" ADD CONSTRAINT "purchase_requirement_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_requirement_line" ADD CONSTRAINT "purchase_requirement_line_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: PurchaseOrder
CREATE TABLE "purchase_order" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'REGISTERED',
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDeliveryDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_order_poNumber_key" ON "purchase_order"("poNumber");
CREATE INDEX "purchase_order_supplierId_idx" ON "purchase_order"("supplierId");
CREATE INDEX "purchase_order_status_idx" ON "purchase_order"("status");
CREATE INDEX "purchase_order_createdById_idx" ON "purchase_order"("createdById");
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: PurchaseOrderItem
CREATE TABLE "purchase_order_item" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "requirementLineId" TEXT,
    "productId" TEXT NOT NULL,
    "quantityOrdered" DECIMAL(14,3) NOT NULL,
    "quantityReceived" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_item_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "purchase_order_item_purchaseOrderId_idx" ON "purchase_order_item"("purchaseOrderId");
CREATE INDEX "purchase_order_item_productId_idx" ON "purchase_order_item"("productId");
CREATE INDEX "purchase_order_item_requirementLineId_idx" ON "purchase_order_item"("requirementLineId");
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_requirementLineId_fkey" FOREIGN KEY ("requirementLineId") REFERENCES "purchase_requirement_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: GoodsReceipt
CREATE TABLE "goods_receipt" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'MATCHED',
    "discrepancyNote" TEXT,
    "confirmedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goods_receipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "goods_receipt_receiptNumber_key" ON "goods_receipt"("receiptNumber");
CREATE INDEX "goods_receipt_purchaseOrderId_idx" ON "goods_receipt"("purchaseOrderId");
CREATE INDEX "goods_receipt_status_idx" ON "goods_receipt"("status");
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: GoodsReceiptItem
CREATE TABLE "goods_receipt_item" (
    "id" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "expectedQty" DECIMAL(14,3) NOT NULL,
    "deliveredQty" DECIMAL(14,3) NOT NULL,
    "actualQty" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "batchNumber" TEXT,
    "manufacturingDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "batchId" TEXT,

    CONSTRAINT "goods_receipt_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "goods_receipt_item_goodsReceiptId_purchaseOrderItemId_key" ON "goods_receipt_item"("goodsReceiptId", "purchaseOrderItemId");
CREATE INDEX "goods_receipt_item_purchaseOrderItemId_idx" ON "goods_receipt_item"("purchaseOrderItemId");
CREATE INDEX "goods_receipt_item_batchId_idx" ON "goods_receipt_item"("batchId");
ALTER TABLE "goods_receipt_item" ADD CONSTRAINT "goods_receipt_item_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_item" ADD CONSTRAINT "goods_receipt_item_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_item" ADD CONSTRAINT "goods_receipt_item_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_item" ADD CONSTRAINT "goods_receipt_item_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: SupplierInvoice
CREATE TABLE "supplier_invoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "invoiceAmount" DECIMAL(12,2) NOT NULL,
    "paymentTerms" TEXT,
    "outstandingBalance" DECIMAL(12,2) NOT NULL,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_invoice_supplierId_invoiceNumber_key" ON "supplier_invoice"("supplierId", "invoiceNumber");
CREATE INDEX "supplier_invoice_supplierId_idx" ON "supplier_invoice"("supplierId");
CREATE INDEX "supplier_invoice_status_idx" ON "supplier_invoice"("status");
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: SupplierPayment
CREATE TABLE "supplier_payment" (
    "id" TEXT NOT NULL,
    "supplierInvoiceId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_payment_supplierInvoiceId_idx" ON "supplier_payment"("supplierInvoiceId");
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_supplierInvoiceId_fkey" FOREIGN KEY ("supplierInvoiceId") REFERENCES "supplier_invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: PurchaseReturn
CREATE TABLE "purchase_return" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "locationId" TEXT NOT NULL,
    "reason" "PurchaseReturnReason" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "returnedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "debitNoteAmount" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_return_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_return_returnNumber_key" ON "purchase_return"("returnNumber");
CREATE INDEX "purchase_return_supplierId_idx" ON "purchase_return"("supplierId");
CREATE INDEX "purchase_return_productId_idx" ON "purchase_return"("productId");
CREATE INDEX "purchase_return_batchId_idx" ON "purchase_return"("batchId");
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;