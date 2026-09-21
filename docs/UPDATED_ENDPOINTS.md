# Updated Purchasing API Endpoints - Change Documentation

**Base URL:** `http://localhost:4000/api/v1/purchasing`
**Authentication:** Better Auth session cookie (login at `POST /api/auth/sign-in/email`)
**Content-Type:** `application/json`
**All endpoints require ADMIN role**

---

## Summary of Recent Changes

This document covers endpoints that have been modified with new features:
- **Purchase Orders**: Shortage acceptance, payment status tracking, unit-aware quantities
- **Goods Receipts**: Unit tracking, improved quantity validation
- **Supplier Invoices**: Financial split (goods/tax/charges/discount), invoice items with double-invoicing protection

---

## 🛒 Purchase Orders

### New Features Added

#### 1. Accept Shortage on PO Item
```http
POST /purchase-orders/items/:itemId/accept-shortage
```

**Purpose:** Accept that a PO item will be delivered short (partial delivery with acknowledged shortage)

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemId` | string (UUID) | Yes | Purchase Order Item ID |

**Request Body:**
```json
{
  "quantityShort": "number (optional, >0, 3 decimals) — defaults to full remaining quantity",
  "shortReason": "string|null (max 500)"
}
```

**Rules:**
- PO must be in `REGISTERED` or `AWAITING_DELIVERY` status (not RECEIVED/CLOSED/CANCELLED)
- `quantityShort` must be > 0
- `received + short` cannot exceed `ordered` quantity
- If `quantityShort` not provided, defaults to: `ordered - received - existingShort`

**Actions Performed:**
1. Updates `quantityShort` and `shortReason` on the PO item
2. If all items become fully accounted for (received + short >= ordered), moves PO to `RECEIVED`

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "purchaseOrderId": "string (UUID)",
    "productId": "string (UUID)",
    "quantityOrdered": "number (3 decimals)",
    "quantityReceived": "number (3 decimals)",
    "quantityShort": "number (3 decimals)",
    "unitCost": "number (2 decimals)",
    "shortReason": "string|null",
    "product": { "id": "string", "name": "string", "sku": "string" }
  }
}
```

**Error Responses:**
- `404 PURCHASE_ORDER_ITEM_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - PO not in valid status
- `422 BAD_REQUEST` - Invalid shortage quantity

---

#### 2. Purchase Order Payment Status Filtering
```http
GET /purchase-orders?paymentStatus=...
```

**New Query Parameter:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paymentStatus` | enum | No | `NOT_INVOICED`, `UNPAID`, `PARTIALLY_PAID`, `PAID`, `ALL` |

**Payment Status Logic (derived, never stored):**
- `NOT_INVOICED` - No invoices linked to this PO
- `UNPAID` - Has invoices, outstanding > 0, paid = 0
- `PARTIALLY_PAID` - Has invoices, outstanding > 0, paid > 0
- `PAID` - Has invoices, outstanding <= 0

---

#### 3. Enhanced PO Detail with Financial Summaries
```http
GET /purchase-orders/:id
```

**New Response Fields:**

```json
{
  "receivingSummary": {
    "orderedQuantity": "number",
    "receivedQuantity": "number",
    "shortQuantity": "number",
    "remainingQuantity": "number"
  },
  "goodsSummary": {
    "orderedGoodsValue": "number — SUM(quantityOrdered × unitCost)",
    "receivedGoodsValue": "number — SUM(quantityReceived × unitCost)",
    "goodsInvoicedAmount": "number — SUM(invoice item goodsAmount)",
    "remainingGoodsToInvoice": "number — receivedGoodsValue - goodsInvoicedAmount"
  },
  "paymentSummary": {
    "status": "NOT_INVOICED | UNPAID | PARTIALLY_PAID | PAID",
    "invoiceCount": "integer",
    "invoicedAmount": "number — SUM(invoice.totalAmount)",
    "paidAmount": "number",
    "outstandingAmount": "number"
  }
}
```

**Important Notes:**
- `goodsSummary` tracks value of physical goods (ordered/received/invoiced)
- `paymentSummary` tracks invoice totals and payments (can differ from goods values due to tax/fees)
- A fully-paid PO can still have `remainingGoodsToInvoice > 0` if new goods are received

---

#### 4. Unit-Aware Purchase Order Items
Each PO item now tracks the unit it was ordered in:

```json
{
  "id": "string (UUID)",
  "productId": "string (UUID)",
  "quantityOrdered": "number — in ordered unit",
  "unitId": "string|null — the unit the quantity is expressed in",
  "quantityOrderedBase": "number — normalized to base unit (for requirement reconciliation)",
  "unitCost": "number"
}
```

---

### Create Purchase Order (Updated)
```http
POST /purchase-orders
```

**Request Body:** (unchanged structure, but now supports `unitId`)
```json
{
  "supplierId": "string (UUID) (required)",
  "expectedDeliveryDate": "ISO8601 datetime|null",
  "notes": "string|null (max 1000)",
  "items": [
    {
      "productId": "string (UUID) (required)",
      "quantityOrdered": "number (required, >0, 3 decimals)",
      "unitCost": "number (required, >0, 2 decimals)",
      "requirementLineId": "string (UUID)|null",
      "unitId": "string|null (optional — defaults to product's base unit)"
    }
  ]
}
```

**Rules (unchanged + new):**
- Minimum 1 item required
- If `requirementLineId` provided:
  - `productId` must match the line's product
  - Line must not be `CLOSED`
  - `quantityOrdered` (converted to base units) must not exceed remaining quantity
- Allocation stored in **base units** for cross-unit reconciliation

---

### Create Purchase Order from Requirement
```http
POST /purchase-orders/from-requirement
```

**Request Body:**
```json
{
  "supplierId": "string (UUID) (required)",
  "expectedDeliveryDate": "ISO8601 datetime|null",
  "notes": "string|null (max 1000)",
  "items": [
    {
      "requirementLineId": "string (UUID) (required)",
      "quantityOrdered": "number (required, >0, 3 decimals)",
      "unitCost": "number (required, >0, 2 decimals)"
    }
  ]
}
```

**Rules:** Same as regular PO creation, but `productId` is derived from requirement line

---

### Update Purchase Order Item
```http
PATCH /purchase-orders/items/:itemId
```

**Request Body:**
```json
{
  "quantityOrdered": "number (>0, 3 decimals)",
  "unitCost": "number (>0, 2 decimals)"
}
```

**Rules:**
- At least one field required
- Cannot reduce quantity below already received quantity
- For requirement-linked items: validates against other active allocations on that line
- Cannot edit items on RECEIVED/CANCELLED/CLOSED orders

---

## 📥 Goods Receipts

### Changes: Unit Tracking & Quantity Validation

#### Create Goods Receipt
```http
POST /purchase-orders/:id/goods-receipts
```

**Request Body:**
```json
{
  "receivedDate": "ISO8601 datetime|null",
  "discrepancyNote": "string|null (max 1000)",
  "items": [
    {
      "purchaseOrderItemId": "string (UUID) (required)",
      "locationId": "string (UUID) (required)",
      "deliveredQty": "number (required, >=0, 3 decimals)",
      "actualQty": "number (required, >=0, 3 decimals)",
      "batchNumber": "string|null (max 100)",
      "manufacturingDate": "ISO8601 datetime|null",
      "expiryDate": "ISO8601 datetime|null"
    }
  ]
}
```

**New Rules:**
- Quantities must be >= 0 (not strictly > 0)
- If `actualQty > 0` AND `deliveredQty > 0`: `batchNumber` and `expiryDate` required
- `actualQty` cannot exceed remaining quantity on PO item
- `expectedQty` auto-calculated: `ordered - received - acceptedShort`
- Each receipt item records `unitId` (the PO item's ordered unit)

**Status Computation:**
- `MATCHED` - All items: `actualQty === deliveredQty === expectedQty`
- `DISCREPANCY` - Any mismatch

---

#### Goods Receipt Item Response (Updated)
```json
{
  "id": "string (UUID)",
  "goodsReceiptId": "string (UUID)",
  "purchaseOrderItemId": "string (UUID)",
  "locationId": "string (UUID)",
  "expectedQty": "number (3 decimals)",
  "deliveredQty": "number (3 decimals)",
  "actualQty": "number (3 decimals)",
  "unitCost": "number (2 decimals)",
  "unitId": "string|null",
  "batchNumber": "string|null",
  "manufacturingDate": "ISO8601 datetime|null",
  "expiryDate": "ISO8601 datetime|null",
  "batchId": "string (UUID)|null",
  "purchaseOrderItem": {
    "id": "string",
    "productId": "string",
    "unitCost": "number"
  },
  "location": { "id": "string", "name": "string" }
}
```

---

## 🧾 Supplier Invoices

### New Features: Financial Split & Invoice Items

#### Create Supplier Invoice (Major Update)
```http
POST /supplier-invoices
```

**Request Body:**
```json
{
  "invoiceNumber": "string (required, max 100)",
  "supplierId": "string (UUID) (required)",
  "purchaseOrderId": "string (UUID)|null",
  "invoiceDate": "ISO8601 datetime|null",
  "dueDate": "ISO8601 datetime|null",
  "goodsAmount": "number (>0, 2 decimals) — required for non-PO invoices",
  "taxAmount": "number (>=0, 2 decimals, default 0)",
  "additionalChargesAmount": "number (>=0, 2 decimals, default 0)",
  "discountAmount": "number (>=0, 2 decimals, default 0)",
  "paymentTerms": "string|null (max 500)",
  "items": [
    {
      "purchaseOrderItemId": "string (UUID) (required for PO-linked invoices)",
      "quantity": "number (>0, in PO item's ordered unit)",
      "unitCost": "number (optional; defaults to PO item's unitCost)"
    }
  ]
}
```

**Financial Model:**
```
totalAmount = goodsAmount + taxAmount + additionalChargesAmount - discountAmount
outstandingBalance = totalAmount - totalPayments
invoiceAmount = totalAmount (legacy mirror)
```

**Rules for PO-Linked Invoices (purchaseOrderId provided):**
1. `items` is **REQUIRED** — must allocate to at least one PO item
2. Server derives `goodsAmount` from allocations: `SUM(quantity × unitCost)`
3. **Double-invoicing protection:** For each PO item, total invoiced across ALL invoices cannot exceed received quantity
4. If `goodsAmount` is supplied, it must match the derived amount
5. `unitCost` defaults to PO item's unitCost if not provided

**Rules for Non-PO Invoices:**
1. `goodsAmount` is **REQUIRED** and must be > 0
2. `items` cannot be provided
3. `discountAmount` requires `goodsAmount`

**Double-Invoicing Protection Details:**
- When creating a PO-linked invoice, the system:
  1. Locks the PO items being invoiced (row-level lock)
  2. Sums already-invoiced quantities across ALL invoices for this PO
  3. Validates: `alreadyInvoiced + newQuantity <= quantityReceived`
- Error: `409 SUPPLIER_INVOICE_EXCEEDS_RECEIVED`

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "invoiceNumber": "string",
    "supplierId": "string (UUID)",
    "purchaseOrderId": "string (UUID)|null",
    "invoiceDate": "ISO8601 datetime",
    "dueDate": "ISO8601 datetime|null",
    "goodsAmount": "number — value of received goods being billed",
    "taxAmount": "number",
    "additionalChargesAmount": "number",
    "discountAmount": "number",
    "totalAmount": "number (= goods + tax + charges - discount)",
    "invoiceAmount": "number (legacy mirror of totalAmount)",
    "paymentTerms": "string|null",
    "outstandingBalance": "number (totalAmount - paid)",
    "status": "OPEN | PARTIALLY_PAID | PAID",
    "items": [
      {
        "id": "string (UUID)",
        "purchaseOrderItemId": "string (UUID)",
        "quantity": "number",
        "unitId": "string|null",
        "unitCost": "number",
        "goodsAmount": "number"
      }
    ],
    "createdById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "supplier": { "id": "string", "name": "string" },
    "purchaseOrder": { "id": "string", "poNumber": "string" }|null
  }
}
```

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`, `PURCHASE_ORDER_NOT_FOUND`
- `409 DUPLICATE_INVOICE_NUMBER` - Per supplier
- `409 SUPPLIER_INVOICE_EXCEEDS_RECEIVED` - Allocation exceeds received-but-not-invoiced quantity
- `422 BAD_REQUEST` - PO belongs to different supplier, negative total, missing items, goodsAmount mismatch

---

#### Get Supplier Invoice (Updated)
```http
GET /supplier-invoices/:id
```

**Response includes:**
```json
{
  "items": [
    {
      "id": "string (UUID)",
      "purchaseOrderItemId": "string (UUID)",
      "quantity": "number",
      "unitId": "string|null",
      "unitCost": "number",
      "goodsAmount": "number",
      "purchaseOrderItem": {
        "id": "string",
        "productId": "string",
        "product": { "id": "string", "name": "string", "sku": "string" },
        "quantityOrdered": "number",
        "quantityReceived": "number",
        "unit": { "id": "string", "name": "string", "symbol": "string" }
      },
      "unit": { "id": "string", "name": "string", "symbol": "string" }|null
    }
  ],
  "payments": [
    {
      "id": "string (UUID)",
      "amount": "number",
      "paymentDate": "ISO8601 datetime",
      "notes": "string|null",
      "recordedBy": { "id": "string", "name": "string" }
    }
  ]
}
```

---

#### Record Payment (Updated Logic)
```http
POST /supplier-invoices/:id/payments
```

**Request Body:**
```json
{
  "amount": "number (required, >0, 2 decimals)",
  "paymentDate": "ISO8601 datetime|null",
  "notes": "string|null (max 500)"
}
```

**Updated Rules:**
- Validates: `amount <= outstandingBalance` (inside transaction with conditional update)
- Concurrent payment protection: uses conditional update (`WHERE outstandingBalance >= amount`)
- If two payments arrive simultaneously, one wins, other gets `SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE`

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "supplierInvoiceId": "string (UUID)",
    "supplierId": "string (UUID)",
    "amount": "number",
    "paymentDate": "ISO8601 datetime",
    "notes": "string|null",
    "recordedById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "recordedBy": { "id": "string", "name": "string" }
  }
}
```

---

## 🗃️ Database Schema Changes

### Migration: 2026-09-21 - PO Shortage and Payment Status
```sql
-- Accepted shortage on purchase order items
ALTER TABLE "purchase_order_item" ADD COLUMN "quantityShort" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_order_item" ADD COLUMN "shortReason" TEXT;

-- Index for PO -> invoices aggregation
CREATE INDEX "supplier_invoice_purchaseOrderId_idx" ON "supplier_invoice"("purchaseOrderId");
```

### Migration: 2026-09-22 - Financial Split & Unit Tracking
```sql
-- Financial split on supplier invoices
ALTER TABLE "supplier_invoice" ADD COLUMN "goodsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "additionalChargesAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Goods allocation tracking (prevents double-invoicing)
CREATE TABLE "supplier_invoice_item" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitId" TEXT,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "goodsAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id")
);

-- Unit tracking across purchasing
ALTER TABLE "purchase_requirement_line" ADD COLUMN "unitId" TEXT;
ALTER TABLE "purchase_requirement_line" ADD COLUMN "quantityNeededBase" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_order_item" ADD COLUMN "unitId" TEXT;
ALTER TABLE "purchase_order_item" ADD COLUMN "quantityOrderedBase" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "goods_receipt_item" ADD COLUMN "unitId" TEXT;
ALTER TABLE "stock_transaction" ADD COLUMN "unitId" TEXT;
ALTER TABLE "stock_transaction" ADD COLUMN "conversionFactor" DECIMAL(12,4);
```

---

## 🔄 New Status Flows

### Purchase Order with Shortage
```plaintext
REGISTERED → AWAITING_DELIVERY → RECEIVED → CLOSED
   |              |
   ↓              ↓
CANCELLED    [accept-shortage]
                  ↓
           (PO moves to RECEIVED when
            all items fully accounted for)
```

**Item Fully Accounted For:** `quantityReceived + quantityShort >= quantityOrdered`

---

## ⚠️ Important Integration Notes

### 1. Unit Conversions
- PO items, requirement lines, and goods receipts now track `unitId`
- `quantityOrderedBase` / `quantityNeededBase` store normalized base-unit values
- When ordering against a requirement line, the system converts your quantity to base units for validation
- "5 Boxes ≠ 5 Tablets" — always handled via base unit conversion

### 2. Payment Status is Derived
- Never trust stored `paymentStatus` field (there isn't one)
- Payment status is computed from: `invoiceCount`, `invoicedAmount`, `outstandingAmount`
- `paidAmount = invoicedAmount - outstandingAmount`

### 3. Invoice Goods vs Invoice Total
- `goodsAmount` = value of physical goods billed
- `totalAmount` = goods + tax + charges - discount (what supplier invoices)
- `invoicedAmount` in PO payment summary = SUM(invoice.totalAmount), NOT goodsAmount
- A PO can have `invoicedAmount > orderedGoodsValue` when tax/fees apply

### 4. Double-Invoicing Protection
- PO-linked invoices MUST include `items` array
- Each item allocates against a specific PO item's received quantity
- Once goods are invoiced, they cannot be invoiced again (even across multiple invoices)
- To invoice more goods, receive more first

### 5. Accepted Shortages
- Shortages reduce the effective "need to receive" on PO items
- Shortages do NOT increase stock (no physical goods added)
- Shortages do NOT count toward requirement fulfillment
- A shortage-accepted item can still move PO to RECEIVED state

---

## Error Codes Added/Changed

| Code | HTTP | When |
|------|------|------|
| `REQUIREMENT_QUANTITY_EXCEEDED` | 409 | Order exceeds remaining quantity on requirement line (includes `requiredQuantity`, `currentlyOrderedQuantity`, `remainingQuantity`, `requestedQuantity` in details) |
| `SUPPLIER_INVOICE_EXCEEDS_RECEIVED` | 409/422 | Invoice allocation exceeds received-but-not-invoiced quantity (includes `purchaseOrderItemId`, `quantityReceived`, `alreadyInvoiced`, `requested`, `remainingGoodsToInvoice`) |
| `GR_ITEM_QUANTITY_MISMATCH` | 422 | Quantity validation failed (now allows 0 values, validates actualQty > 0 when deliveredQty > 0) |
| `PO_STATUS_TRANSITION_INVALID` | 409 | Now also blocks shortage acceptance on RECEIVED/CLOSED/CANCELLED POs |
