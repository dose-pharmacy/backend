# Financials, Reporting & Analytics API Documentation

**Base URL:** `http://localhost:4000/api/v1/financials`  
**Authentication:** Better Auth session cookie (login at `POST /api/auth/sign-in/email`)  
**Content-Type:** `application/json`  
**All endpoints require ADMIN role**

---

## 📋 Table of Contents

1. [Generic Products](#generic-products)
2. [Manufacturers](#manufacturers)
3. [Discount Authorization Rules](#discount-authorization-rules)
4. [Slow Moving Configuration](#slow-moving-configuration)
5. [Financial Reports](#financial-reports)
6. [Sales (POS)](#sales-pos)
7. [Dashboard](#dashboard)
8. [Error Codes](#error-codes)

---

## 🏷️ Generic Products

### List Generic Products
```
GET /generic-products
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: 1) |
| `limit` | integer | No | Items per page (default: 20, max: 100) |
| `search` | string | No | Search in name, description |
| `isActive` | boolean | No | Filter by active status |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "name": "string",
      "description": "string|null",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",
      "_count": { "products": "integer" }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
}
```

---

### Create Generic Product
```
POST /generic-products
```

**Request Body:**
```json
{
  "name": "string (required, max 200)",
  "description": "string|null (max 1000)"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "name": "string",
    "description": "string|null",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime"
  }
}
```

**Error Responses:**
- `409 DUPLICATE_GENERIC_PRODUCT` - Name already exists
- `422 VALIDATION_ERROR` - Invalid input

---

### Get Generic Product by ID
```
GET /generic-products/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:** Full generic product with product count

**Error Responses:** `404 GENERIC_PRODUCT_NOT_FOUND`

---

### Update Generic Product
```
PATCH /generic-products/:id
```

**Request Body:** (all optional)
```json
{
  "name": "string (max 200)",
  "description": "string|null (max 1000)"
}
```

**Error Responses:**
- `404 GENERIC_PRODUCT_NOT_FOUND`
- `409 DUPLICATE_GENERIC_PRODUCT`
- `422 VALIDATION_ERROR`

---

### Delete Generic Product
```
DELETE /generic-products/:id
```

**Error Responses:**
- `404 GENERIC_PRODUCT_NOT_FOUND`
- `409 GENERIC_PRODUCT_IN_USE` - Has associated products

---

## Manufacturers

### List Manufacturers
```
GET /manufacturers
```

**Query Parameters:** `page`, `limit`, `search`, `isActive`

**Response 200:** List with product counts

---

### Create Manufacturer
```
POST /manufacturers
```

**Request Body:**
```json
{
  "name": "string (required, max 200)",
  "contactInfo": "string|null (max 500)",
  "isActive": "boolean (default: true)"
}
```

**Error Responses:**
- `409 DUPLICATE_MANUFACTURER`
- `422 VALIDATION_ERROR`

---

### Get Manufacturer by ID
```
GET /manufacturers/:id
```

**Response 200:** Manufacturer with product count

**Error Responses:** `404 MANUFACTURER_NOT_FOUND`

---

### Update Manufacturer
```
PATCH /manufacturers/:id
```

**Request Body:** (all optional)
```json
{
  "name": "string (max 200)",
  "contactInfo": "string|null (max 500)",
  "isActive": "boolean"
}
```

**Error Responses:**
- `404 MANUFACTURER_NOT_FOUND`
- `409 DUPLICATE_MANUFACTURER`
- `409 INACTIVE_MANUFACTURER`

---

### Delete Manufacturer
```
DELETE /manufacturers/:id
```

**Error Responses:**
- `404 MANUFACTURER_NOT_FOUND`
- `409 MANUFACTURER_IN_USE` - Has associated products

---

## 💰 Discount Authorization Rules

### List Discount Rules
```
GET /discount-auth-rules
```

**Query Parameters:** `page`, `limit`, `scope` (ITEM|BILL), `isActive`

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "scope": "ITEM|BILL",
      "maxDiscountPct": "number (2 decimals)",
      "roleRequiredAbove": "string|null",
      "isActive": "boolean",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 10, "totalPages": 1 }
}
```

---

### Create Discount Rule
```
POST /discount-auth-rules
```

**Request Body:**
```json
{
  "scope": "ITEM|BILL (required)",
  "maxDiscountPct": "number (required, 0-100, 2 decimals)",
  "roleRequiredAbove": "string|null (max 50)",
  "isActive": "boolean (default: true)"
}
```

**Error Responses:**
- `422 VALIDATION_ERROR`

---

### Get Discount Rule by ID
```
GET /discount-auth-rules/:id
```

---

### Update Discount Rule
```
PATCH /discount-auth-rules/:id
```

**Request Body:** (all optional)
```json
{
  "scope": "ITEM|BILL",
  "maxDiscountPct": "number (0-100)",
  "roleRequiredAbove": "string|null (max 50)",
  "isActive": "boolean"
}
```

---

### Delete Discount Rule
```
DELETE /discount-auth-rules/:id
```

---

### Check Discount Authorization
```
POST /discount-auth-rules/check
```

**Request Body:**
```json
{
  "scope": "ITEM|BILL (required)",
  "discountPct": "number (required)",
  "userRole": "string (required)"
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "authorized": "boolean",
    "maxAllowed": "number",
    "requiredRole": "string|null"
  }
}
```

---

## 🐌 Slow Moving Configuration

### List Slow Moving Configs
```
GET /slow-moving-configs
```

**Query Parameters:** `page`, `limit`, `productId`, `isFlagged`, `definitionType` (DAYS_30|DAYS_60|DAYS_90|DAYS_180|CUSTOM)

**Response 200:** Configs with product info

---

### Create Slow Moving Config
```
POST /slow-moving-configs
```

**Request Body:**
```json
{
  "productId": "string (UUID, required)",
  "definitionType": "DAYS_30|DAYS_60|DAYS_90|DAYS_180|CUSTOM (required)",
  "customDays": "integer (1-365, required if CUSTOM)"
}
```

**Error Responses:**
- `409 BAD_REQUEST` - Config already exists for product
- `422 INVALID_SLOW_MOVING_DEFINITION` - Custom days required for CUSTOM

---

### Get Slow Moving Config by ID
```
GET /slow-moving-configs/:id
```

---

### Get Slow Moving Config by Product
```
GET /slow-moving-configs/product/:productId
```

---

### Update Slow Moving Config
```
PATCH /slow-moving-configs/:id
```

**Request Body:**
```json
{
  "definitionType": "DAYS_30|DAYS_60|DAYS_90|DAYS_180|CUSTOM",
  "customDays": "integer (1-365)|null"
}
```

**Error Responses:**
- `422 INVALID_SLOW_MOVING_DEFINITION`

---

### Delete Slow Moving Config
```
DELETE /slow-moving-configs/:id
```

---

### Evaluate Slow Moving (Run Analysis)
```
POST /slow-moving-configs/evaluate
```

**Action:** Recomputes `lastSaleDate`, `daysSinceLastSale` and `isFlagged` for every slow moving configuration.

**Behaviour**
- Uses **one grouped query** to fetch the latest valid (COMPLETED) sale per product — no per-config query.
- Applies every configuration in **one atomic bulk update** inside a single transaction: the evaluation state is never partially written.
- Guarded by a PostgreSQL transaction-scoped **advisory lock**: a second evaluation started while one is running exits with `409 CONFLICT`.
- **Idempotent**: re-running with unchanged sales/configuration produces the same state, with no duplicate rows or side effects.
- Thresholds: `DAYS_30` → 30, `DAYS_60` → 60, `DAYS_90` → 90, `DAYS_180` → 180, `CUSTOM` → `customDays` (must be 1–365). A product is flagged when `daysSinceLastSale >= thresholdDays`.
- Products that have **never been sold** keep `lastSaleDate = null`, `daysSinceLastSale = null` and stay unflagged.
- Configurations with an invalid stored `CUSTOM` definition are skipped (reported in `skipped`) rather than failing the run.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "evaluated": 420,
    "flagged": 24,
    "unflagged": 396,
    "skipped": 0,
    "evaluatedAt": "2026-09-19T18:30:00.000Z",
    "durationMs": 350
  }
}
```

**Response 409:** another evaluation is already running.

---

### Get Flagged Slow Moving Products
```
GET /slow-moving-configs/flagged
```

**Query Parameters:** `page`, `limit`

**Response 200:** Flagged products with stock value

---

## 📊 Financial Reports

### Reporting conventions

All report endpoints share one predictable contract.

**Envelope**
- Paginated endpoints: `{ "success": true, "data": [...], "meta": { "page", "limit", "total", "totalPages" } }`. `total`/`totalPages` describe the **entire filtered dataset**, never just the fetched page.
- Summary/trend endpoints: `{ "success": true, "data": ... }` with no pagination metadata.

**Pagination** — `page >= 1` (default 1) and `1 <= limit <= 100` (default 20). Out-of-range values are rejected with `422`.

**Date filtering** — `dateFrom` / `dateTo` are ISO8601 and are **inclusive of the whole UTC day**: `dateTo = 2026-09-19` includes everything up to `2026-09-19T23:59:59.999Z`. Omitting both defaults to the last 30 days ending today. `dateFrom > dateTo` is rejected with `422`.

**Sorting** — list endpoints accept `sortBy` + `sortOrder` (`asc` | `desc`). `sortBy` is validated against a per-endpoint allowlist and rejected with `422` when unknown; arbitrary column names can never reach the database.

**Valid sales** — every report counts only sales with `status = COMPLETED` (cancelled/voided sales are excluded) and reads sale lines from the canonical `SaleItem` table, using batch allocations for real cost of goods sold.

---

### Profit Margin Report
```
GET /reports/profit-margin
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `page`, `limit` | integer | Pagination |
| `productGroupId` | UUID | Filter by product group |
| `dateFrom`, `dateTo` | ISO8601 | Sales period filter |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "productGroupId": "string",
      "productGroupName": "string",
      "productGroupMargin": "number",
      "productId": "string",
      "productName": "string",
      "sku": "string",
      "sellingPrice": "number",
      "costPrice": "number",
      "targetMargin": "number",
      "actualMargin": "number",
      "revenue": "number",
      "cost": "number",
      "quantitySold": "number"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
}
```

**Sorting:** `productName`, `actualMargin`, `targetMargin`, `revenue`, `cost`, `quantitySold`, `sellingPrice`

---

### Profit Margin Summary
```
GET /reports/profit-margin/summary
```

**Query Parameters:** `productGroupId`, `dateFrom`, `dateTo`

Aggregates over the **complete filtered product set** (no pagination). Products with no sales in the window keep `actualMargin = targetMargin`, so they are not reported as below target. Zero revenue, zero quantity and missing target margins are handled without yielding `NaN` or `Infinity`.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "productCount": 120,
    "belowTargetCount": 18,
    "averageTargetMargin": 30,
    "averageActualMargin": 27.5
  }
}
```

---

### Profitability Report
```
GET /reports/profitability
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `groupBy` | enum | BRAND, MANUFACTURER, PRODUCT_GROUP, PRODUCT (default: PRODUCT) |
| `productGroupId` | UUID | Filter by group |
| `manufacturerId` | UUID | Filter by manufacturer |
| `dateFrom`, `dateTo` | ISO8601 | Period filter |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "dimension": "PRODUCT_GROUP",
      "value": "Painkillers",
      "revenue": 150000,
      "cost": 90000,
      "profit": 60000,
      "margin": 40.0,
      "quantity": 5000,
      "productCount": 5
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 10, "totalPages": 1 }
}
```

**Sorting:** `profit`, `revenue`, `cost`, `margin`, `quantity`, `productCount`, `value`

---

### Profitability Summary
```
GET /reports/profitability/summary
```

**Query Parameters:** `groupBy`, `productGroupId`, `manufacturerId`, `dateFrom`, `dateTo`

Totals for the **entire filtered dataset**, computed in the database — the frontend must never sum a page of records to derive financial totals. `margin` is a percentage and is `0` when revenue is `0`.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "revenue": 1500000,
    "cost": 900000,
    "profit": 600000,
    "margin": 40,
    "quantity": 5000,
    "productCount": 120
  }
}
```

---

### Slow Moving Report
```
GET /reports/slow-moving
```

**Query Parameters:** `page`, `limit`, `productGroupId`, `manufacturerId`, `isFlagged`, `definitionType`

**Response 200:** Flagged products with stock value

---

### Sales Trend (time series)
```
GET /reports/sales/trend
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `period` | enum | `DAILY` (default), `MONTHLY`, `ANNUAL` |
| `dateFrom`, `dateTo` | ISO8601 | Inclusive UTC day range |
| `locationId` | UUID | Filter by location |

Buckets are produced **in the database** (`date_trunc` + `GROUP BY`). Revenue and `transactionCount` come from the sale header, so a sale with several lines is counted once; `quantitySold` comes from the sale lines. Periods with no sales are returned as zero buckets rather than omitted, and `period` is formatted as `YYYY-MM-DD` / `YYYY-MM` / `YYYY`.

**Response 200:**
```json
{
  "success": true,
  "data": [
    { "period": "2026-09-01", "revenue": 85000, "transactionCount": 12, "quantitySold": 320 }
  ]
}
```

---

### Sales Report (List)
```
GET /reports/sales
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `dateFrom`, `dateTo` | ISO8601 | Inclusive UTC day range |
| `locationId` | UUID | Filter by location |
| `page`, `limit` | integer | Pagination |
| `sortBy`, `sortOrder` | enum | `createdAt` (default), `saleNumber`, `totalAmount`, `paidAmount` |

**Response 200:** Sales with their lines (`items`), payments, location and cashier. `lines` was replaced by `items` because the previous field read a legacy, unpopulated table.

---

### Sales Summary
```
GET /reports/sales/summary
```

**Query Parameters:** `dateFrom`, `dateTo`, `locationId`

**Response 200:**
```json
{
  "success": true,
  "data": {
    "totalSales": 1500000,
    "totalSubtotal": 1550000,
    "totalDiscount": 50000,
    "transactionCount": 150,
    "averageTransaction": 10000,
    "paymentsByMethod": [
      { "method": "CASH", "amount": 900000 },
      { "method": "CARD", "amount": 400000 },
      { "method": "DIGITAL_TRANSFER", "amount": 200000 }
    ],
    "topProducts": [
      { "productId": "uuid", "name": "Paracetamol", "sku": "PARA-500", "revenue": 150000, "quantity": 30000 }
    ]
  }
}
```

---

### Sales Detail (Drill-down)
```
GET /reports/sales/detail
```

**Query Parameters:** `page`, `limit`, `saleId`, `productId`, `cashierId`, `locationId`, `dateFrom`, `dateTo`

**Response 200:** Sale lines with sale, product, location, cashier info

---

## 🛒 Sales (POS)

### List Sales
```
GET /sales
```

**Query Parameters:** `page`, `limit`, `status` (COMPLETED|VOIDED), `locationId`, `cashierId`, `dateFrom`, `dateTo`

---

### Create Sale (POS)
```
POST /sales
```

**Request Body:**
```json
{
  "locationId": "string (UUID, required)",
  "lines": [
    {
      "productId": "string (UUID, required)",
      "unitSold": "string (required, e.g., Tablet, Strip, Box)",
      "quantity": "number (required, >0, 3 decimals)",
      "quantityBaseUnits": "number (required, >0, 3 decimals)",
      "unitPrice": "number (required, >0, 2 decimals)",
      "itemDiscountAmount": "number (optional, 2 decimals)"
    }
  ],
  "billDiscountAmount": "number (optional, 2 decimals)",
  "payments": [
    {
      "method": "CASH|CARD|DIGITAL_TRANSFER (required)",
      "amount": "number (required, >0, 2 decimals)",
      "referenceNumber": "string (optional, max 100)"
    }
  ]
}
```

**Validations:**
- All products must be active and have stock at location (FEFO)
- Payment amounts must sum to total amount
- Item/bill discounts checked against authorization rules

**Actions Performed:**
1. Records stock movements (SALE, OUT) using FEFO
2. Creates sale with lines and payments
3. Updates stock quantities

**Response 201:** Full sale with lines, payments, stock info

---

### Get Sale by ID
```
GET /sales/:id
```

---

### Update Sale
```
PATCH /sales/:id
```

**Request Body:**
```json
{
  "voidReason": "string|null",
  "status": "COMPLETED|VOIDED"
}
```

---

### Void Sale
```
POST /sales/:id/void
```

**Request Body:**
```json
{
  "voidReason": "string (required, max 500)"
}
```

**Actions:**
- Reverses stock movements (RETURN_IN)
- Marks sale as VOIDED
- Creates audit trail

---

### Get Sales Detail (Drill-down)
```
GET /sales/detail
```

**Query Parameters:** `page`, `limit`, `saleId`, `productId`, `cashierId`, `locationId`, `dateFrom`, `dateTo`

---

## 📈 Dashboard

**Base URL:** `http://localhost:4000/api/v1/dashboard`

The Dashboard module answers **"what is happening right now and what needs my attention?"**. It is deliberately small and operational — it does NOT duplicate the Reports module. Detailed sales/profitability/inventory analysis remains in `/financials/reports/*`.

### Backend audit — data sources reused

The dashboard introduces no second definitions of business values. Every metric reuses existing backend logic:

| Metric | Reused source |
|--------|---------------|
| Today's sales / transactions / average | `Sale` table, `status = COMPLETED` (same rule as reports), aggregated in the database from UTC midnight (`startOfTodayUtc`) |
| Stock value | `SUM(inventory_stock.quantity × product_unit.purchasePrice)` on the **base unit** — the same formula as the slow-moving report |
| Low stock / out of stock | Same logic as `inventory/dashboard.service.ts`: active products with `SUM(stock) > 0 AND <= minimumStock` (low) or no positive stock rows (out) |
| Expiring soon / expired | `Batch.expiryDate` with **30-day window** (`EXPIRY_SOON_DAYS`), counted only when the batch still has positive stock |
| Open requirements | `PurchaseRequirement.status = OPEN` |
| Awaiting delivery | `PurchaseOrder.status = AWAITING_DELIVERY` |
| Partially received | PO in `REGISTERED`/`AWAITING_DELIVERY` with at least one item where `0 < quantityReceived < quantityOrdered` (PO status alone is not authoritative) |
| Outstanding invoices | `SupplierInvoice.status IN (OPEN, PARTIALLY_PAID)` |
| Slow-moving flagged | Reads the **persisted** `isFlagged` on `SlowMovingConfiguration` only — it never triggers `POST /slow-moving-configs/evaluate` |

**Performance:** each endpoint runs its independent queries in parallel via `Promise.all`; all aggregation is done in the database (no in-memory number crunching). Summary = 12 parallel queries; Attention = 4; Recent Activity = 3.

### Dashboard Summary
```
GET /api/v1/dashboard/summary
```

**Auth:** session cookie, ADMIN role.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "sales": {
      "today": 125400,
      "transactions": 84,
      "averageTransaction": 1492.86
    },
    "inventory": {
      "stockValue": 2400000,
      "lowStockCount": 12,
      "outOfStockCount": 4,
      "expiringSoonCount": 7,
      "expiredCount": 2
    },
    "purchasing": {
      "openRequirements": 8,
      "awaitingDelivery": 5,
      "partiallyReceived": 2,
      "outstandingInvoices": 3
    },
    "slowMoving": {
      "flaggedCount": 24
    }
  }
}
```

**Field notes**
- `sales.today` — total of COMPLETED sales created today (UTC day boundary). `0` when no sales today.
- `sales.averageTransaction` — `today / transactions`, rounded to 2 decimals; `0` (never NaN/Infinity) when `transactions = 0`.
- `inventory.expiredCount` / `expiringSoonCount` — batches with remaining stock only; fully-depleted expired batches are not counted.
- All numeric fields are always present numbers (`0` instead of `null`).

**Error Responses:** `401 UNAUTHENTICATED`, `403 FORBIDDEN`

---

### Dashboard Attention
```
GET /api/v1/dashboard/attention
```

**Auth:** session cookie, ADMIN role.

Returns small actionable lists — **max 5 items per category** (low stock sorted by least available first, expiring batches by soonest expiry, POs by expected delivery date, invoices by due date).

**Response 200:**
```json
{
  "success": true,
  "data": {
    "lowStock": [
      {
        "productId": "uuid",
        "productName": "Amoxicillin",
        "sku": "AMOX-300-200",
        "availableStock": 4,
        "reorderPoint": 20
      }
    ],
    "expiringSoon": [
      {
        "batchId": "uuid",
        "productId": "uuid",
        "productName": "Amoxicillin",
        "batchNumber": "B-2026-04",
        "expiryDate": "2026-10-05T00:00:00.000Z",
        "remainingQuantity": 25
      }
    ],
    "awaitingDelivery": [
      {
        "purchaseOrderId": "uuid",
        "poNumber": "PO-1024",
        "supplierName": "MedSupply Ltd",
        "expectedDeliveryDate": "2026-09-22T00:00:00.000Z"
      }
    ],
    "outstandingInvoices": [
      {
        "invoiceId": "uuid",
        "invoiceNumber": "INV-2026-001",
        "supplierName": "MedSupply Ltd",
        "outstandingBalance": 15000,
        "dueDate": "2026-09-25T00:00:00.000Z"
      }
    ]
  }
}
```

All lists are `[]` (empty array) when there is nothing to action. `expectedDeliveryDate`/`dueDate` may be `null`.

**Error Responses:** `401 UNAUTHENTICATED`, `403 FORBIDDEN`

---

### Dashboard Recent Activity
```
GET /api/v1/dashboard/recent-activity
```

**Auth:** session cookie, ADMIN role.

Merges the last 5 events from each of three operational sources (completed sales, goods receipts, purchase orders — excluding cancelled), sorts newest-first and returns up to 10 items. No central audit log exists in the codebase, so this is query-based rather than event-store-based.

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "type": "SALE_COMPLETED | GOODS_RECEIVED | PURCHASE_ORDER_CREATED",
      "reference": "S-2026-0091",
      "description": "Sale completed",
      "createdAt": "2026-09-20T09:15:00.000Z"
    }
  ]
}
```

**Error Responses:** `401 UNAUTHENTICATED`, `403 FORBIDDEN`

---

## ❌ Error Codes Reference

| Code | HTTP | Description |
|------|------|-------------|
| `BAD_REQUEST` | 400 | Invalid request |
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Business rule violation |
| `VALIDATION_ERROR` | 422 | Input validation failed |

**Financials-Specific:**
| Code | HTTP | Description |
|------|------|-------------|
| `GENERIC_PRODUCT_NOT_FOUND` | 404 | Generic product doesn't exist |
| `DUPLICATE_GENERIC_PRODUCT` | 409 | Name already exists |
| `GENERIC_PRODUCT_IN_USE` | 409 | Has associated products |
| `MANUFACTURER_NOT_FOUND` | 404 | Manufacturer doesn't exist |
| `DUPLICATE_MANUFACTURER` | 409 | Name exists |
| `MANUFACTURER_IN_USE` | 409 | Has associated products |
| `INACTIVE_MANUFACTURER` | 409 | Manufacturer not active |
| `SALE_NOT_FOUND` | 404 | Sale doesn't exist |
| `DUPLICATE_SALE_NUMBER` | 409 | Sale number exists |
| `SALE_ALREADY_VOIDED` | 409 | Already voided |
| `CANNOT_VOID_SALE` | 409 | Cannot void completed sale |
| `INSUFFICIENT_STOCK_FOR_SALE` | 409 | Not enough stock |
| `PAYMENT_AMOUNT_EXCEEDS_TOTAL` | 422 | Payments > total |
| `DISCOUNT_AUTH_RULE_NOT_FOUND` | 404 | Rule doesn't exist |
| `DISCOUNT_EXCEEDS_AUTHORIZED_LIMIT` | 403 | Discount > allowed limit |
| `ROLE_NOT_AUTHORIZED_FOR_DISCOUNT` | 403 | Role lacks permission |
| `SLOW_MOVING_CONFIG_NOT_FOUND` | 404 | Config doesn't exist |
| `INVALID_SLOW_MOVING_DEFINITION` | 422 | Invalid definition type |

---

## 🔄 Status Flows

### Sale
```
COMPLETED → VOIDED
```

### Discount Authorization
```
No rule → No limit
Has rule → Check discountPct ≤ maxDiscountPct
  → If exceeded, check roleRequiredAbove
```

### Slow Moving
```
Config created → Manual/auto evaluate → isFlagged updated
  → Flagged products shown in report
```

---

## 📝 Common Response Format

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { ... }
  }
}
```

---

## 📝 Quick Reference: All Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/generic-products` | List generic products |
| POST | `/generic-products` | Create generic product |
| GET | `/generic-products/:id` | Get generic product |
| PATCH | `/generic-products/:id` | Update generic product |
| DELETE | `/generic-products/:id` | Delete generic product |
| GET | `/manufacturers` | List manufacturers |
| POST | `/manufacturers` | Create manufacturer |
| GET | `/manufacturers/:id` | Get manufacturer |
| PATCH | `/manufacturers/:id` | Update manufacturer |
| DELETE | `/manufacturers/:id` | Delete manufacturer |
| GET | `/discount-auth-rules` | List discount rules |
| POST | `/discount-auth-rules` | Create discount rule |
| GET | `/discount-auth-rules/:id` | Get discount rule |
| PATCH | `/discount-auth-rules/:id` | Update discount rule |
| DELETE | `/discount-auth-rules/:id` | Delete discount rule |
| POST | `/discount-auth-rules/check` | Check authorization |
| GET | `/slow-moving-configs` | List slow moving configs |
| POST | `/slow-moving-configs` | Create slow moving config |
| GET | `/slow-moving-configs/:id` | Get config by ID |
| GET | `/slow-moving-configs/product/:productId` | Get config by product |
| PATCH | `/slow-moving-configs/:id` | Update config |
| DELETE | `/slow-moving-configs/:id` | Delete config |
| POST | `/slow-moving-configs/evaluate` | Run evaluation |
| GET | `/slow-moving-configs/flagged` | Get flagged products |
| GET | `/reports/profit-margin` | Profit margin report |
| GET | `/reports/profit-margin/summary` | Profit margin summary |
| GET | `/reports/profitability` | Profitability report |
| GET | `/reports/profitability/summary` | Profitability summary |
| GET | `/reports/slow-moving` | Slow moving report |
| GET | `/reports/sales` | Sales report |
| GET | `/reports/sales/trend` | Sales trend time series |
| GET | `/reports/sales/summary` | Sales summary |
| GET | `/reports/sales/detail` | Sales detail |
| GET | `/sales` | List sales |
| POST | `/sales` | Create sale |
| GET | `/sales/:id` | Get sale |
| PATCH | `/sales/:id` | Update sale |
| POST | `/sales/:id/void` | Void sale |
| GET | `/sales/detail` | Sales detail drill-down |
| GET | `/dashboard/summary` | Operational KPI summary |
| GET | `/dashboard/attention` | Actionable lists (≤5 per category) |
| GET | `/dashboard/recent-activity` | Last 10 operational events |

**Total: 50 endpoints**