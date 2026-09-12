# Pharmacy Purchasing & Supplier Management API - Complete Documentation

**Base URL:** `http://localhost:4000/api/v1/purchasing`  
**Authentication:** Better Auth session cookie (login at `POST /api/auth/sign-in/email`)  
**Content-Type:** `application/json`  
**All endpoints require ADMIN role**

---

## 📋 Table of Contents

1. [Suppliers](#suppliers)
2. [Purchase Requirements](#purchase-requirements)
3. [Purchase Orders](#purchase-orders)
4. [Goods Receipts](#goods-receipts)
5. [Supplier Invoices](#supplier-invoices)
6. [Purchase Returns](#purchase-returns)
7. [Error Codes](#error-codes)

---

## 🏢 Suppliers

### List Suppliers
```
GET /suppliers
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: 1) |
| `limit` | integer | No | Items per page (default: 20, max: 100) |
| `search` | string | No | Search in name, contactPerson, email |
| `isActive` | boolean | No | Filter by active status |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "name": "string",
      "contactPerson": "string|null",
      "email": "string|null",
      "phone": "string|null",
      "address": "string|null",
      "paymentTerms": "string|null",
      "isActive": "boolean",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",
      "_count": {
        "purchaseOrders": "integer",
        "supplierInvoices": "integer",
        "purchaseReturns": "integer"
      },
      "totalOutstanding": "number"
    }
  ],
  "meta": {
    "page": "integer",
    "limit": "integer",
    "total": "integer",
    "totalPages": "integer"
  }
}
```

---

### Create Supplier
```
POST /suppliers
```

**Request Body:**
```json
{
  "name": "string (required, max 200)",
  "contactPerson": "string|null (max 200)",
  "email": "string|null (max 200, valid email)",
  "phone": "string|null (max 50)",
  "address": "string|null (max 500)",
  "paymentTerms": "string|null (max 500)",
  "isActive": "boolean (default: true)"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "name": "string",
    "contactPerson": "string|null",
    "email": "string|null",
    "phone": "string|null",
    "address": "string|null",
    "paymentTerms": "string|null",
    "isActive": "boolean",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime"
  }
}
```

**Error Responses:**
- `409 DUPLICATE_SUPPLIER` - Name already exists
- `422 VALIDATION_ERROR` - Invalid input

---

### Get Supplier by ID
```
GET /suppliers/:id
```

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Supplier ID |

**Response 200:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "name": "string",
    "contactPerson": "string|null",
    "email": "string|null",
    "phone": "string|null",
    "address": "string|null",
    "paymentTerms": "string|null",
    "isActive": "boolean",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "purchaseOrders": [
      {
        "id": "string (UUID)",
        "poNumber": "string",
        "status": "string",
        "orderDate": "ISO8601 datetime",
        "expectedDeliveryDate": "ISO8601 datetime|null"
      }
    ],
    "supplierInvoices": [
      {
        "id": "string (UUID)",
        "invoiceNumber": "string",
        "status": "string",
        "invoiceAmount": "number",
        "outstandingBalance": "number"
      }
    ],
    "_count": {
      "purchaseOrders": "integer",
      "supplierInvoices": "integer",
      "purchaseReturns": "integer"
    },
    "totalOutstanding": "number"
  }
}
```

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`

---

### Update Supplier
```
PATCH /suppliers/:id
```

**Path Parameters:** `id` (UUID)

**Request Body:** (all fields optional)
```json
{
  "name": "string (max 200)",
  "contactPerson": "string|null (max 200)",
  "email": "string|null (max 200)",
  "phone": "string|null (max 50)",
  "address": "string|null (max 500)",
  "paymentTerms": "string|null (max 500)",
  "isActive": "boolean"
}
```

**Response 200:** Same as Get Supplier

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`
- `409 DUPLICATE_SUPPLIER`
- `422 VALIDATION_ERROR`

---

### Delete Supplier
```
DELETE /suppliers/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:**
```json
{
  "success": true,
  "data": null
}
```

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`
- `409 SUPPLIER_IN_USE` - Has related POs, invoices, returns, etc.

---

## 📋 Purchase Requirements

### List Requirements
```
GET /requirements
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default: 1 |
| `limit` | integer | No | Default: 20, max: 100 |
| `status` | enum | No | `OPEN`, `ASSIGNED`, `CLOSED` |
| `search` | string | No | Search in reference, notes |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "reference": "string",
      "status": "OPEN|ASSIGNED|CLOSED",
      "requiredBy": "ISO8601 datetime|null",
      "notes": "string|null",
      "createdById": "string (UUID)",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",
      "lines": [
        {
          "id": "string (UUID)",
          "requirementId": "string (UUID)",
          "productId": "string (UUID)",
          "quantityNeeded": "number (3 decimals)",
          "quantityDelivered": "number (3 decimals)",
          "reasonCode": "LOW_STOCK|REORDER_ALERT|MANUAL|null",
          "supplierId": "string (UUID)|null",
          "status": "OPEN|ASSIGNED|CLOSED",
          "notes": "string|null",
          "createdAt": "ISO8601 datetime",
          "updatedAt": "ISO8601 datetime",
          "product": {
            "id": "string (UUID)",
            "name": "string",
            "sku": "string"
          },
          "supplier": {
            "id": "string (UUID)",
            "name": "string"
          }|null,
          "purchaseOrderItems": [
            {
              "id": "string (UUID)",
              "purchaseOrderId": "string (UUID)",
              "quantityOrdered": "number (3 decimals)"
            }
          ]
        }
      ],
      "createdBy": {
        "id": "string (UUID)",
        "name": "string"
      }
    }
  ],
  "meta": {
    "page": "integer",
    "limit": "integer",
    "total": "integer",
    "totalPages": "integer"
  }
}
```

---

### Create Requirement
```
POST /requirements
```

**Request Body:**
```json
{
  "requiredBy": "ISO8601 datetime|null",
  "notes": "string|null (max 1000)",
  "lines": [
    {
      "productId": "string (UUID) (required)",
      "quantityNeeded": "number (required, >0, 3 decimals)",
      "reasonCode": "LOW_STOCK|REORDER_ALERT|MANUAL|null",
      "notes": "string|null (max 500)"
    }
  ]
}
```
- Minimum 1 line required
- No duplicate products within

### Get Requirement by ID
```
GET /requirements/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:** Same structure as list item with full lines array

**Error Responses:**
- `404 REQUIREMENT_NOT_FOUND`

---

### Update Requirement Header
```
PATCH /requirements/:id
```

**Path Parameters:** `id` (UUID)

**Request Body:** (all optional)
```json
{
  "requiredBy": "ISO8601 datetime|null",
  "notes": "string|null (max 1000)"
}
```

**Response 200:** Updated requirement with lines

**Error Responses:**
- `404 REQUIREMENT_NOT_FOUND`
- `409 REQUIREMENT_CLOSED` - Cannot modify closed requirement

---

### Close Requirement
```
POST /requirements/:id/close
```

**Path Parameters:** `id` (UUID)

**Response 200:** Closed requirement with all lines set to CLOSED

**Error Responses:**
- `404 REQUIREMENT_NOT_FOUND`
- `409 REQUIREMENT_CLOSED` - Already closed

---

### Delete Requirement
```
DELETE /requirements/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:**
```json
{ "success": true, "data": null }
```

**Error Responses:**
- `404 REQUIREMENT_NOT_FOUND`
- `409 REQUIREMENT_LINE_HAS_PO` - Has associated purchase orders

---

### Generate from Reorder
```
POST /requirements/generate-from-reorder
```

**Request Body:** None

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "reference": "string",
    "status": "OPEN",
    "notes": "Auto-generated from reorder suggestions",
    "createdById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "lines": [
      {
        "id": "string (UUID)",
        "productId": "string (UUID)",
        "quantityNeeded": "number",
        "reasonCode": "REORDER_ALERT",
        "notes": "Suggested by reorder (CONFIGURED|SALES_VELOCITY)",
        "status": "OPEN"
      }
    ]
  }
}
```

**Error Responses:**
- `409 BAD_REQUEST` - No reorder suggestions available

---

## 📋 Purchase Requirement Lines

### Add Line to Requirement
```
POST /requirements/:id/lines
```

**Path Parameters:** `id` (UUID) - Requirement ID

**Request Body:**
```json
{
  "productId": "string (UUID) (required)",
  "quantityNeeded": "number (required, >0, 3 decimals)",
  "reasonCode": "LOW_STOCK|REORDER_ALERT|MANUAL|null",
  "notes": "string|null (max 500)"
}
```

**Response 201:** Created line object

**Error Responses:**
- `404 REQUIREMENT_NOT_FOUND`
- `409 REQUIREMENT_CLOSED`
- `409 DUPLICATE_PRODUCT_IN_REQUIREMENT`

---

### Update Requirement Line
```
PATCH /requirements/lines/:lineId
```

**Path Parameters:** `lineId` (UUID)

**Request Body:** (all optional)
```json
{
  "quantityNeeded": "number (>0, 3 decimals)",
  "reasonCode": "LOW_STOCK|REORDER_ALERT|MANUAL|null",
  "notes": "string|null (max 500)",
  "status": "OPEN|ASSIGNED|CLOSED"
}
```

**Response 200:** Updated line object

**Error Responses:**
- `404 REQUIREMENT_LINE_NOT_FOUND`
- `409 REQUIREMENT_CLOSED`

---

### Assign Supplier to Line
```
POST /requirements/lines/:lineId/assign-supplier
```

**Path Parameters:** `lineId` (UUID)

**Request Body:**
```json
{
  "supplierId": "string (UUID) (required)"
}
```

**Response 200:** Updated line with supplier info, status becomes ASSIGNED

**Error Responses:**
- `404 REQUIREMENT_LINE_NOT_FOUND`
- `404 SUPPLIER_NOT_FOUND`
- `409 INACTIVE_SUPPLIER`
- `409 REQUIREMENT_CLOSED`

---

### Remove Requirement Line
```
DELETE /requirements/lines/:lineId
```

**Path Parameters:** `lineId` (UUID)

**Response 200:**
```json
{ "success": true, "data": null }
```

**Error Responses:**
- `404 REQUIREMENT_LINE_NOT_FOUND`
- `409 REQUIREMENT_CLOSED`
- `409 REQUIREMENT_LINE_HAS_PO` - Has associated purchase orders

---

## 🛒 Purchase Orders

### List Purchase Orders
```
GET /purchase-orders
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default: 1 |
| `limit` | integer | No | Default: 20, max: 100 |
| `supplierId` | UUID | No | Filter by supplier |
| `status` | enum | No | `REGISTERED`, `AWAITING_DELIVERY`, `RECEIVED`, `CLOSED`, `CANCELLED` |
| `search` | string | No | Search in poNumber, notes |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "poNumber": "string",
      "supplierId": "string (UUID)",
      "status": "REGISTERED|AWAITING_DELIVERY|RECEIVED|CLOSED|CANCELLED",
      "orderDate": "ISO8601 datetime",
      "expectedDeliveryDate": "ISO8601 datetime|null",
      "notes": "string|null",
      "createdById": "string (UUID)",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",
      "supplier": { "id": "string", "name": "string" },
      "createdBy": { "id": "string", "name": "string" },
      "_count": { "items": "integer" }
    }
  ],
  "meta": { "page": "integer", "limit": "integer", "total": "integer", "totalPages": "integer" }
}
```

---

### Create Purchase Order
```
POST /purchase-orders
```

**Request Body:**
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
      "requirementLineId": "string (UUID)|null"
    }
  ]
}
```
- Minimum 1 item required
- If `requirementLineId` provided, it must belong to the same supplier

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "poNumber": "string (e.g., PO-1234567890)",
    "supplierId": "string (UUID)",
    "status": "REGISTERED",
    "orderDate": "ISO8601 datetime",
    "expectedDeliveryDate": "ISO8601 datetime|null",
    "notes": "string|null",
    "createdById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "supplier": { "id": "string", "name": "string" },
    "createdBy": { "id": "string", "name": "string" },
    "items": [
      {
        "id": "string (UUID)",
        "purchaseOrderId": "string (UUID)",
        "requirementLineId": "string (UUID)|null",
        "productId": "string (UUID)",
        "quantityOrdered": "number (3 decimals)",
        "quantityReceived": "number (3 decimals)",
        "unitCost": "number (2 decimals)",
        "createdAt": "ISO8601 datetime",
        "updatedAt": "ISO8601 datetime",
        "product": { "id": "string", "name": "string", "sku": "string" },
        "requirementLine": { "id": "string", "quantityNeeded": "number", "quantityDelivered": "number" }|null
      }
    ]
  }
}
```

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `REQUIREMENT_LINE_NOT_FOUND`
- `409 INACTIVE_SUPPLIER`
- `422 PO_REQUIREMENT_LINE_SUPPLIER_MISMATCH`

---

### Get Purchase Order by ID
```
GET /purchase-orders/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "poNumber": "string",
    "supplierId": "string (UUID)",
    "status": "string",
    "orderDate": "ISO8601 datetime",
    "expectedDeliveryDate": "ISO8601 datetime|null",
    "notes": "string|null",
    "createdById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "supplier": {
      "id": "string",
      "name": "string",
      "contactPerson": "string|null",
      "email": "string|null",
      "phone": "string|null"
    },
    "createdBy": { "id": "string", "name": "string" },
    "items": [
      {
        "id": "string (UUID)",
        "purchaseOrderId": "string (UUID)",
        "requirementLineId": "string (UUID)|null",
        "productId": "string (UUID)",
        "quantityOrdered": "number",
        "quantityReceived": "number",
        "unitCost": "number",
        "createdAt": "ISO8601 datetime",
        "updatedAt": "ISO8601 datetime",
        "product": { "id": "string", "name": "string", "sku": "string" },
        "requirementLine": { "id": "string", "quantityNeeded": "number", "quantityDelivered": "number" }|null
      }
    ],
    "goodsReceipts": [
      {
        "id": "string (UUID)",
        "receiptNumber": "string",
        "status": "string",
        "receivedDate": "ISO8601 datetime"
      }
    ]
  }
}
```

---

### Update Purchase Order
```
PATCH /purchase-orders/:id
```

**Path Parameters:** `id` (UUID)

**Request Body:** (all optional)
```json
{
  "expectedDeliveryDate": "ISO8601 datetime|null",
  "notes": "string|null (max 1000)"
}
```

**Response 200:** Updated PO

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - Cannot modify CANCELLED/CLOSED

---

### Mark as Awaiting Delivery
```
POST /purchase-orders/:id/mark-delivered
```

**Path Parameters:** `id` (UUID)

**Status Transition:** `REGISTERED` → `AWAITING_DELIVERY`

**Response 200:** Updated PO with `status: "AWAITING_DELIVERY"`

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - Only from REGISTERED

---

### Cancel Purchase Order
```
POST /purchase-orders/:id/cancel
```

**Path Parameters:** `id` (UUID)

**Status Transition:** `REGISTERED|AWAITING_DELIVERY` → `CANCELLED`

**Response 200:** Updated PO with `status: "CANCELLED"`

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`
- `409 PO_CANNOT_CANCEL` - Cannot cancel RECEIVED/CLOSED/CANCELLED

---

### Close Purchase Order
```
POST /purchase-orders/:id/close
```

**Path Parameters:** `id` (UUID)

**Status Transition:** `RECEIVED` → `CLOSED`

**Validates:** All items fully received (`quantityReceived >= quantityOrdered`)

**Response 200:** Updated PO with `status: "CLOSED"`

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - Only from RECEIVED, or items not fully received

---

## 📥 Goods Receipts

### List Goods Receipts
```
GET /goods-receipts
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default: 1 |
| `limit` | integer | No | Default: 20, max: 100 |
| `purchaseOrderId` | UUID | No | Filter by PO |
| `status` | enum | No | `MATCHED`, `DISCREPANCY`, `RESOLVED` |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "receiptNumber": "string (e.g., GR-1234567890)",
      "purchaseOrderId": "string (UUID)",
      "supplierId": "string (UUID)",
      "receivedDate": "ISO8601 datetime",
      "status": "MATCHED|DISCREPANCY|RESOLVED",
      "discrepancyNote": "string|null",
      "confirmedById": "string (UUID)|null",
      "createdById": "string (UUID)",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",
      "purchaseOrder": { "id": "string", "poNumber": "string", "supplierId": "string" },
      "createdBy": { "id": "string", "name": "string" },
      "confirmedBy": { "id": "string", "name": "string" }|null,
      "_count": { "items": "integer" }
    }
  ],
  "meta": { "page": "integer", "limit": "integer", "total": "integer", "totalPages": "integer" }
}
```

---

### Create Goods Receipt
```
POST /purchase-orders/:id/goods-receipts
```

**Path Parameters:** `id` (UUID) - Purchase Order ID

**Request Body:**
```json
{
  "receivedDate": "ISO8601 datetime|null",
  "discrepancyNote": "string|null (max 1000)",
  "items": [
    {
      "purchaseOrderItemId": "string (UUID) (required)",
      "locationId": "string (UUID) (required)",
      "deliveredQty": "number (required, >0, 3 decimals)",
      "actualQty": "number (required, >0, 3 decimals)",
      "batchNumber": "string|null (max 100)",
      "manufacturingDate": "ISO8601 datetime|null",
      "expiryDate": "ISO8601 datetime|null"
    }
  ]
}
```
- Minimum 1 item required
- `purchaseOrderItemId` must belong to the PO
- If `actualQty > 0`: `batchNumber` and `expiryDate` required
- `expectedQty` auto-calculated from PO (ordered - received)

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "receiptNumber": "string",
    "purchaseOrderId": "string (UUID)",
    "supplierId": "string (UUID)",
    "receivedDate": "ISO8601 datetime",
    "status": "MATCHED|DISCREPANCY",
    "discrepancyNote": "string|null",
    "createdById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "purchaseOrder": { "id": "string", "poNumber": "string" },
    "createdBy": { "id": "string", "name": "string" },
    "items": [
      {
        "id": "string (UUID)",
        "goodsReceiptId": "string (UUID)",
        "purchaseOrderItemId": "string (UUID)",
        "locationId": "string (UUID)",
        "expectedQty": "number (3 decimals)",
        "deliveredQty": "number (3 decimals)",
        "actualQty": "number (3 decimals)",
        "unitCost": "number (2 decimals)",
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
    ]
  }
}
```

**Status Computed:**
- `MATCHED` if all items: `actualQty === deliveredQty === expectedQty`
- `DISCREPANCY` otherwise

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`, `PURCHASE_ORDER_ITEM_NOT_FOUND`, `LOCATION_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - PO is CANCELLED/CLOSED
- `422 GOODS_RECEIPT_BATCH_REQUIRED` - batchNumber required when actualQty > 0
- `422 GOODS_RECEIPT_EXPIRY_REQUIRED` - expiryDate required when actualQty > 0
- `422 GR_ITEM_QUANTITY_MISMATCH` - actualQty must be > 0

---

### Get Goods Receipt by ID
```
GET /goods-receipts/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "receiptNumber": "string",
    "purchaseOrderId": "string (UUID)",
    "supplierId": "string (UUID)",
    "receivedDate": "ISO8601 datetime",
    "status": "MATCHED|DISCREPANCY|RESOLVED",
    "discrepancyNote": "string|null",
    "confirmedById": "string (UUID)|null",
    "createdById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "updatedAt": "ISO8601 datetime",
    "purchaseOrder": {
      "id": "string",
      "poNumber": "string",
      "supplierId": "string",
      "supplier": { "id": "string", "name": "string" }
    },
    "createdBy": { "id": "string", "name": "string" },
    "confirmedBy": { "id": "string", "name": "string" }|null,
    "items": [
      {
        "id": "string (UUID)",
        "goodsReceiptId": "string (UUID)",
        "purchaseOrderItemId": "string (UUID)",
        "locationId": "string (UUID)",
        "expectedQty": "number",
        "deliveredQty": "number",
        "actualQty": "number",
        "unitCost": "number",
        "batchNumber": "string|null",
        "manufacturingDate": "ISO8601 datetime|null",
        "expiryDate": "ISO8601 datetime|null",
        "batchId": "string (UUID)|null",
        "purchaseOrderItem": {
          "id": "string",
          "productId": "string",
          "product": { "id": "string", "name": "string", "sku": "string" },
          "unitCost": "number",
          "quantityOrdered": "number",
          "quantityReceived": "number"
        },
        "location": { "id": "string", "name": "string" },
        "batch": { "id": "string", "batchNumber": "string", "expiryDate": "ISO8601 datetime" }|null
      }
    ]
  }
}
```

---

### Resolve Discrepancy
```
PATCH /goods-receipts/:id/resolve
```

**Path Parameters:** `id` (UUID)

**Request Body:** (all optional)
```json
{
  "discrepancyNote": "string|null (max 1000)",
  "items": [
    {
      "id": "string (UUID) (required)",
      "deliveredQty": "number (>0, 3 decimals)|null",
      "actualQty": "number (>0, 3 decimals)|null",
      "batchNumber": "string|null (max 100)",
      "manufacturingDate": "ISO8601 datetime|null",
      "expiryDate": "ISO8601 datetime|null"
    }
  ]
}
```

**Response 200:** Updated receipt with new status

**Status Recomputed:**
- `MATCHED` if all items now match
- `RESOLVED` if discrepancyNote provided and still mismatched
- `DISCREPANCY` if still mismatched and no note

**Error Responses:**
- `404 GOODS_RECEIPT_NOT_FOUND`, `GOODS_RECEIPT_ITEM_NOT_FOUND`
- `409 BAD_REQUEST` - Already MATCHED

---

### Confirm Goods Receipt
```
POST /goods-receipts/:id/confirm
```

**Path Parameters:** `id` (UUID)

**Preconditions:** Status must be `MATCHED` or `RESOLVED`, not already confirmed

**Actions Performed:**
1. Creates/updates batches for each item
2. Records stock movements (`PURCHASE`, `IN`) at location
3. Updates PO item `quantityReceived`
4. Updates requirement line `quantityDelivered` and closes if fulfilled
5. Updates PO status to `RECEIVED` (if all items) or `AWAITING_DELIVERY` (partial)
6. Marks receipt confirmed with `confirmedById`

**Response 200:** Confirmed receipt with `status: "MATCHED"`, `confirmedById`

**Error Responses:**
- `404 GOODS_RECEIPT_NOT_FOUND`
- `409 GOODS_RECEIPT_ALREADY_CONFIRMED`
- `409 GOODS_RECEIPT_CANNOT_CONFIRM` - Must be MATCHED/RESOLVED
- `422 INVALID_EXPIRY_DATE` - Expiry must be at least tomorrow

---

### Delete Goods Receipt
```
DELETE /goods-receipts/:id
```

**Path Parameters:** `id` (UUID)

**Precondition:** Not confirmed (`confirmedById` is null)

**Response 200:**
```json
{ "success": true, "data": null }
```

**Error Responses:**
- `404 GOODS_RECEIPT_NOT_FOUND`
- `409 GOODS_RECEIPT_ALREADY_CONFIRMED`

---

## 🧾 Supplier Invoices

### List Supplier Invoices
```
GET /supplier-invoices
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default: 1 |
| `limit` | integer | No | Default: 20, max: 100 |
| `supplierId` | UUID | No | Filter by supplier |
| `status` | enum | No | `OPEN`, `PARTIALLY_PAID`, `PAID` |
| `search` | string | No | Search in invoiceNumber, supplier name |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "invoiceNumber": "string",
      "supplierId": "string (UUID)",
      "purchaseOrderId": "string (UUID)|null",
      "invoiceDate": "ISO8601 datetime",
      "dueDate": "ISO8601 datetime|null",
      "invoiceAmount": "number (2 decimals)",
      "paymentTerms": "string|null",
      "outstandingBalance": "number (2 decimals)",
      "status": "OPEN|PARTIALLY_PAID|PAID",
      "createdById": "string (UUID)",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",
      "supplier": { "id": "string", "name": "string" },
      "purchaseOrder": { "id": "string", "poNumber": "string" }|null,
      "createdBy": { "id": "string", "name": "string" },
      "payments": [
        {
          "id": "string (UUID)",
          "amount": "number (2 decimals)",
          "paymentDate": "ISO8601 datetime",
          "notes": "string|null",
          "recordedBy": { "id": "string", "name": "string" }
        }
      ]
    }
  ],
  "meta": { "page": "integer", "limit": "integer", "total": "integer", "totalPages": "integer" }
}
```

---

### Create Supplier Invoice
```
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
  "invoiceAmount": "number (required, >0, 2 decimals)",
  "paymentTerms": "string|null (max 500)"
}
```
- `invoiceNumber` must be unique per supplier
- If `purchaseOrderId` provided, must belong to same supplier

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
    "invoiceAmount": "number",
    "paymentTerms": "string|null",
    "outstandingBalance": "number (equals invoiceAmount)",
    "status": "OPEN",
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
- `422 BAD_REQUEST` - PO belongs to different supplier

---

### Get Supplier Invoice by ID
```
GET /supplier-invoices/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:** Invoice with full payment history

---

### Update Supplier Invoice
```
PATCH /supplier-invoices/:id
```

**Path Parameters:** `id` (UUID)

**Request Body:** (all optional)
```json
{
  "dueDate": "ISO8601 datetime|null",
  "paymentTerms": "string|null (max 500)"
}
```

**Response 200:** Updated invoice

**Error Responses:**
- `404 SUPPLIER_INVOICE_NOT_FOUND`
- `409 BAD_REQUEST` - Cannot modify PAID invoice

---

### Record Payment
```
POST /supplier-invoices/:id/payments
```

**Path Parameters:** `id` (UUID) - Invoice ID

**Request Body:**
```json
{
  "amount": "number (required, >0, 2 decimals)",
  "paymentDate": "ISO8601 datetime|null",
  "notes": "string|null (max 500)"
}
```
- Validates: `amount <= outstandingBalance`
- Auto-updates invoice `outstandingBalance` and `status`

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

**Error Responses:**
- `404 SUPPLIER_INVOICE_NOT_FOUND`
- `422 SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE`

---

### Delete Supplier Invoice
```
DELETE /supplier-invoices/:id
```

**Path Parameters:** `id` (UUID)

**Precondition:** No payments recorded

**Response 200:**
```json
{ "success": true, "data": null }
```

**Error Responses:**
- `404 SUPPLIER_INVOICE_NOT_FOUND`
- `409 BAD_REQUEST` - Has recorded payments

---

## 🔄 Purchase Returns

### List Purchase Returns
```
GET /purchase-returns
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default: 1 |
| `limit` | integer | No | Default: 20, max: 100 |
| `supplierId` | UUID | No | Filter by supplier |
| `productId` | UUID | No | Filter by product |
| `reason` | enum | No | `EXPIRED`, `DAMAGED`, `INCORRECT_DELIVERY` |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "returnNumber": "string (e.g., PRN-1234567890)",
      "supplierId": "string (UUID)",
      "productId": "string (UUID)",
      "batchId": "string (UUID)|null",
      "locationId": "string (UUID)",
      "reason": "EXPIRED|DAMAGED|INCORRECT_DELIVERY",
      "quantity": "number (3 decimals)",
      "returnedDate": "ISO8601 datetime",
      "debitNoteAmount": "number (2 decimals)",
      "unitCost": "number (2 decimals)",
      "notes": "string|null",
      "recordedById": "string (UUID)",
      "createdAt": "ISO8601 datetime",
      "supplier": { "id": "string", "name": "string" },
      "product": { "id": "string", "name": "string", "sku": "string" },
      "batch": { "id": "string", "batchNumber": "string", "expiryDate": "ISO8601 datetime" }|null,
      "location": { "id": "string", "name": "string" },
      "recordedBy": { "id": "string", "name": "string" }
    }
  ],
  "meta": { "page": "integer", "limit": "integer", "total": "integer", "totalPages": "integer" }
}
```

---

### Create Purchase Return
```
POST /purchase-returns
```

**Request Body:**
```json
{
  "supplierId": "string (UUID) (required)",
  "productId": "string (UUID) (required)",
  "batchId": "string (UUID)|null",
  "locationId": "string (UUID) (required)",
  "reason": "EXPIRED|DAMAGED|INCORRECT_DELIVERY (required)",
  "quantity": "number (required, >0, 3 decimals)",
  "unitCost": "number (required, >0, 2 decimals)",
  "debitNoteAmount": "number (2 decimals)|null",
  "notes": "string|null (max 1000)"
}
```
- If `batchId` not provided, uses first batch with stock at location
- If `debitNoteAmount` not provided, calculated as `unitCost * quantity`
- Records stock movement `RETURN_TO_SUPPLIER` (OUT)

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "string (UUID)",
    "returnNumber": "string",
    "supplierId": "string (UUID)",
    "productId": "string (UUID)",
    "batchId": "string (UUID)|null",
    "locationId": "string (UUID)",
    "reason": "string",
    "quantity": "number",
    "unitCost": "number",
    "debitNoteAmount": "number",
    "notes": "string|null",
    "recordedById": "string (UUID)",
    "createdAt": "ISO8601 datetime",
    "supplier": { "id": "string", "name": "string" },
    "product": { "id": "string", "name": "string", "sku": "string" },
    "batch": { "id": "string", "batchNumber": "string", "expiryDate": "ISO8601 datetime" }|null,
    "location": { "id": "string", "name": "string" }
  }
}
```

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `BATCH_NOT_FOUND`, `LOCATION_NOT_FOUND`
- `409 INACTIVE_SUPPLIER`, `INACTIVE_LOCATION`
- `422 BATCH_PRODUCT_MISMATCH`, `PURCHASE_RETURN_INSUFFICIENT_STOCK`

---

### Get Purchase Return by ID
```
GET /purchase-returns/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:** Full return details

---

### Delete Purchase Return
```
DELETE /purchase-returns/:id
```

**Path Parameters:** `id` (UUID)

**Note:** Does NOT reverse stock movement (kept for audit trail)

**Response 200:**
```json
{ "success": true, "data": null }
```

**Error Responses:**
- `404 PURCHASE_RETURN_NOT_FOUND`

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
| `RATE_LIMITED` | 429 | Too many requests |
| `DATABASE_ERROR` | 500 | Database error |
| `INTERNAL_ERROR` | 500 | Server error |

**Purchasing-Specific:**
| Code | HTTP | Description |
|------|------|-------------|
| `SUPPLIER_NOT_FOUND` | 404 | Supplier doesn't exist |
| `DUPLICATE_SUPPLIER` | 409 | Supplier name exists |
| `SUPPLIER_IN_USE` | 409 | Has related records |
| `INACTIVE_SUPPLIER` | 409 | Supplier not active |
| `REQUIREMENT_NOT_FOUND` | 404 | Requirement doesn't exist |
| `REQUIREMENT_CLOSED` | 409 | Cannot modify closed |
| `REQUIREMENT_LINE_NOT_FOUND` | 404 | Line doesn't exist |
| `REQUIREMENT_LINE_HAS_PO` | 409 | Line has PO items |
| `DUPLICATE_PRODUCT_IN_REQUIREMENT` | 409 | Duplicate product |
| `PURCHASE_ORDER_NOT_FOUND` | 404 | PO doesn't exist |
| `PURCHASE_ORDER_ITEM_NOT_FOUND` | 404 | PO item doesn't exist |
| `DUPLICATE_PO_NUMBER` | 409 | PO number exists |
| `PO_STATUS_TRANSITION_INVALID` | 409 | Invalid status change |
| `PO_CANNOT_CANCEL` | 409 | Cannot cancel received/closed |
| `PO_REQUIREMENT_LINE_SUPPLIER_MISMATCH` | 422 | Line supplier ≠ PO supplier |
| `GOODS_RECEIPT_NOT_FOUND` | 404 | Receipt doesn't exist |
| `GOODS_RECEIPT_ITEM_NOT_FOUND` | 404 | Receipt item doesn't exist |
| `GOODS_RECEIPT_ALREADY_CONFIRMED` | 409 | Already confirmed |
| `GOODS_RECEIPT_CANNOT_CONFIRM` | 409 | Must be MATCHED/RESOLVED |
| `GOODS_RECEIPT_DISCREPANCY_UNRESOLVED` | 409 | Must resolve first |
| `GOODS_RECEIPT_BATCH_REQUIRED` | 422 | batchNumber required |
| `GOODS_RECEIPT_EXPIRY_REQUIRED` | 422 | expiryDate required |
| `GR_ITEM_QUANTITY_MISMATCH` | 422 | actualQty must be >0 |
| `SUPPLIER_INVOICE_NOT_FOUND` | 404 | Invoice doesn't exist |
| `DUPLICATE_INVOICE_NUMBER` | 409 | Invoice number exists for supplier |
| `SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE` | 422 | Payment > outstanding |
| `PURCHASE_RETURN_NOT_FOUND` | 404 | Return doesn't exist |
| `DUPLICATE_RETURN_NUMBER` | 409 | Return number exists |
| `PURCHASE_RETURN_INSUFFICIENT_STOCK` | 409 | Not enough stock |
| `INVALID_EXPIRY_DATE` | 422 | Expiry must be >= tomorrow |
| `BATCH_NOT_FOUND` | 404 | Batch doesn't exist |
| `DUPLICATE_BATCH` | 409 | Batch number exists for product |
| `BATCH_PRODUCT_MISMATCH` | 422 | Batch ≠ product |
| `EXPIRED_BATCH` | 409 | Cannot add to expired batch |
| `BATCH_IN_USE` | 409 | Has stock/transactions |
| `LOCATION_NOT_FOUND` | 404 | Location doesn't exist |
| `DUPLICATE_LOCATION` | 409 | Location name exists |
| `LOCATION_IN_USE` | 409 | Has stock/transactions |
| `INACTIVE_LOCATION` | 409 | Location not active |
| `INSUFFICIENT_STOCK` | 409 | Not enough stock for OUT movement |
| `INVALID_STOCK_QUANTITY` | 422 | Quantity must be >0 |

---

## 🔄 Complete Status Flows

### Purchase Order
```
REGISTERED → AWAITING_DELIVERY → RECEIVED → CLOSED
                    ↓
               CANCELLED (from REGISTERED or AWAITING_DELIVERY)
```

### Goods Receipt
```
MATCHED (auto if all match) ↔ DISCREPANCY (mismatch)
    ↓                              ↓
CONFIRMED                      RESOLVED (with note) → MATCHED → CONFIRMED
```

### Supplier Invoice
```
OPEN → PARTIALLY_PAID → PAID
```

### Purchase Requirement
```
OPEN → ASSIGNED (supplier assigned) → CLOSED (fully delivered)
```

### Purchase Requirement Line
```
OPEN → ASSIGNED → CLOSED
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