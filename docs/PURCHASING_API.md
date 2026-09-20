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
| `status` | enum | No | `OPEN`, `PARTIALLY_FULFILLED`, `FULFILLED`, `CLOSED` |
| `search` | string | No | Search in reference, notes |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",      "reference": "string",
      "status": "OPEN|PARTIALLY_FULFILLED|FULFILLED|CLOSED",
      "requiredBy": "ISO8601 datetime|null",
      "notes": "string|null",
      "createdById": "string (UUID)",
      "createdAt": "ISO8601 datetime",
      "updatedAt": "ISO8601 datetime",      "lines": [
        {
          "id": "string (UUID)",
          "requirementId": "string (UUID)",
          "productId": "string (UUID)",
          "product": { "id": "string (UUID)", "name": "string", "sku": "string" },
          "requiredQuantity": "number (3 decimals)",
          "quantityNeeded": "number (3 decimals) (alias of requiredQuantity)",
          "quantityOrdered": "number (3 decimals) (sum of active allocations; alias orderedQuantity)",
          "quantityRemaining": "number (3 decimals) (required - ordered; aliases remainingQuantity, remainingToOrder)",
          "quantityDelivered": "number (3 decimals)",
          "remainingToReceive": "number (3 decimals) (ordered - delivered)",
          "activeOrderCount": "integer (non-cancelled POs ordering this line)",
          "reasonCode": "LOW_STOCK|REORDER_ALERT|MANUAL|null",
          "status": "OPEN|PARTIALLY_FULFILLED|FULFILLED|CLOSED (derived from active allocations)",
          "notes": "string|null",
          "createdAt": "ISO8601 datetime",
          "updatedAt": "ISO8601 datetime",
          "allocations": [
            {
              "id": "string (UUID)",
              "quantityAllocated": "number (3 decimals)",
              "active": "boolean (false when the PO is CANCELLED)",
              "purchaseOrderItemId": "string (UUID)",
              "purchaseOrderId": "string (UUID)",
              "purchaseOrderNumber": "string",
              "purchaseOrderStatus": "REGISTERED|AWAITING_DELIVERY|RECEIVED|CLOSED|CANCELLED",
              "supplier": { "id": "string (UUID)", "name": "string" }|null,
              "quantityOrdered": "number (3 decimals)",
              "quantityReceived": "number (3 decimals)",
              "unitCost": "number (2 decimals)",
              "createdAt": "ISO8601 datetime",
              "updatedAt": "ISO8601 datetime"
            }
          ]
        }
      ],
      "createdBy": {
        "id": "string (UUID)",
        "name": "string"
      }
    }
  ],  "meta": {
    "page": "integer",
    "limit": "integer",
    "total": "integer",
    "totalPages": "integer"
  }
}
```

> **Derived quantities:** `quantityOrdered` is summed from *active* allocations
> (allocations whose purchase order is not `CANCELLED`) and can never be set by the client.
> Cancelling a purchase order automatically releases its allocation. Unless a line was
> manually closed, its status is derived: `OPEN` (nothing ordered), `PARTIALLY_FULFILLED`
> (ordered < required), `FULFILLED` (ordered ≥ required); `CLOSED` is sticky.

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
- Lines start as `OPEN`; ordered/remaining quantities are derived from allocations created
  when purchase orders are placed (never client-supplied)

### Get Requirement by ID
```
GET /requirements/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:** Same structure as list item with full lines array. Unlike the list view,
the detail view also includes cancelled allocations (with `active: false`) for auditability.

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

Closing is blocked while purchase orders are still pending — cancel or receive them first.

**Error Responses:**
- `404 REQUIREMENT_NOT_FOUND`
- `409 REQUIREMENT_CLOSED` - Already closed
- `409 REQUIREMENT_HAS_ACTIVE_ORDERS` - POs in REGISTERED/AWAITING_DELIVERY exist

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
- `409 REQUIREMENT_HAS_ACTIVE_ORDERS` - Has active (non-cancelled) purchase orders

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

**Path Parameters:** `lineId` (UUID)**Request Body:** (all optional — fulfillment `status` is derived by the backend and any
`status` sent is stripped)
```json
{
  "quantityNeeded": "number (>0, 3 decimals)",
  "reasonCode": "LOW_STOCK|REORDER_ALERT|MANUAL|null",
  "notes": "string|null (max 500)"
}
```

**Response 200:** Updated line object

**Error Responses:**
- `404 REQUIREMENT_LINE_NOT_FOUND`
- `409 REQUIREMENT_CLOSED`
- `409 REQUIREMENT_QUANTITY_BELOW_ORDERED` - Cannot reduce required quantity below what is
  already ordered (details: `requiredQuantity`, `currentlyOrderedQuantity`, `remainingQuantity`)

---### Get Line Order Preview
```
GET /requirements/lines/:lineId/order-preview
```

**Path Parameters:** `lineId` (UUID)

Read-only prefill payload for starting a purchase order from a requirement line. The
backend tells the client exactly how much is still available — never compute it yourself.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "requirementLineId": "string (UUID)",
    "requirementId": "string (UUID)",
    "requirementReference": "string",
    "requirementStatus": "OPEN|PARTIALLY_FULFILLED|FULFILLED|CLOSED",
    "requiredBy": "ISO8601 datetime|null",
    "product": { "id": "string (UUID)", "name": "string", "sku": "string" },
    "requiredQuantity": "number (3 decimals)",
    "orderedQuantity": "number (3 decimals)",
    "remainingQuantity": "number (3 decimals)",
    "suggestedOrderQuantity": "number (3 decimals) (equals remainingQuantity)",
    "activeOrderCount": "integer",
    "lineStatus": "OPEN|PARTIALLY_FULFILLED|FULFILLED|CLOSED"
  }
}
```

**Error Responses:**
- `404 REQUIREMENT_LINE_NOT_FOUND`

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
- `409 REQUIREMENT_HAS_ACTIVE_ORDERS` - Has active (non-cancelled) purchase orders

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
- If `requirementLineId` is provided, an allocation is created linking the PO item to the
  requirement line. `productId` must match the line's product, the line must not be
  `CLOSED`, and `quantityOrdered` must not exceed the line's remaining quantity
  (required − active allocations) or the request fails with `409 REQUIREMENT_QUANTITY_EXCEEDED`
  (details: `requiredQuantity`, `currentlyOrderedQuantity`, `remainingQuantity`, `requestedQuantity`)
- A requirement line can be fulfilled by several POs, even from different suppliers;
  cancelling a PO releases its allocation automatically

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
        "updatedAt": "ISO8601 datetime",        "product": { "id": "string", "name": "string", "sku": "string" },
        "requirementLine": {
          "id": "string",
          "quantityNeeded": "number",
          "quantityDelivered": "number",
          "status": "OPEN|PARTIALLY_FULFILLED|FULFILLED|CLOSED",
          "requirement": { "id": "string", "reference": "string", "status": "string" }
        }|null,
        "allocations": [
          { "id": "string (UUID)", "requirementLineId": "string (UUID)", "quantityAllocated": "number (3 decimals)" }
        ]
      }
    ]
  }
}
```

**Error Responses:**
- `404 SUPPLIER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `REQUIREMENT_LINE_NOT_FOUND`
- `409 INACTIVE_SUPPLIER`
- `409 REQUIREMENT_CLOSED` - Requirement line is closed
- `409 REQUIREMENT_QUANTITY_EXCEEDED` - More than the line's remaining quantity
- `422 BAD_REQUEST` - `productId` does not match the requirement line's product

---

### Create Purchase Order from Requirement
```
POST /purchase-orders/from-requirement
```

Variant of `POST /purchase-orders` for ordering straight from requirement lines. The product
for each item is derived from the requirement line, so the client only picks a supplier,
quantity and unit cost. Items may come from different requirement lines (and different
requirements); all allocation, over-order and status recomputation rules apply.

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

**Response 201:** Same as Create Purchase Order (items carry `requirementLine` and `allocations`)

**Error Responses:** Same as Create Purchase Order

---

### Update Purchase Order Item
```
PATCH /purchase-orders/items/:itemId
```

**Path Parameters:** `itemId` (UUID)

Edits quantity/cost on a single item. On requirement-linked items the allocation is resized
and validated against the *other* active allocations on that line.

**Request Body:** (at least one field)
```json
{
  "quantityOrdered": "number (>0, 3 decimals)",
  "unitCost": "number (>0, 2 decimals)"
}
```

**Response 200:** Updated item with `product` and `allocations`

**Error Responses:**
- `404 PURCHASE_ORDER_ITEM_NOT_FOUND`, `REQUIREMENT_LINE_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - Item is on a RECEIVED/CANCELLED/CLOSED order, or
  quantity reduced below the quantity already received
- `409 REQUIREMENT_QUANTITY_EXCEEDED` - Would exceed the line's remaining quantity

---

### Remove Purchase Order Item
```
DELETE /purchase-orders/items/:itemId
```

**Path Parameters:** `itemId` (UUID)

Removes an item from a draft (`REGISTERED`) order and releases its requirement allocation.

**Response 200:**
```json
{ "success": true, "data": null }
```

**Error Responses:**
- `404 PURCHASE_ORDER_ITEM_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - Order not REGISTERED, or item has received quantity

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
        "updatedAt": "ISO8601 datetime",        "product": { "id": "string", "name": "string", "sku": "string" },
        "requirementLine": {
          "id": "string",
          "quantityNeeded": "number",
          "quantityDelivered": "number",
          "status": "OPEN|PARTIALLY_FULFILLED|FULFILLED|CLOSED",
          "requirement": { "id": "string", "reference": "string", "status": "string" }
        }|null,
        "allocations": [
          { "id": "string (UUID)", "requirementLineId": "string (UUID)", "quantityAllocated": "number (3 decimals)" }
        ]
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
POST /purchase-orders/:id/mark-awaiting-delivery
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

Cancelling automatically releases the order's requirement allocations — ordered quantities
on the affected requirement lines drop and their statuses are recomputed.

**Response 200:** Updated PO with `status: "CANCELLED"`

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`
- `409 PO_CANNOT_CANCEL` - Cannot cancel RECEIVED/CLOSED/CANCELLED, or any item has received quantity

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
4. Increments requirement line `quantityDelivered` (fulfillment status stays derived from
   active allocations — receiving never closes a requirement)
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
| `REQUIREMENT_HAS_ACTIVE_ORDERS` | 409 | Requirement (or line) has non-cancelled POs |
| `REQUIREMENT_QUANTITY_BELOW_ORDERED` | 409 | Reducing required qty below what is ordered |
| `REQUIREMENT_QUANTITY_EXCEEDED` | 409 | Order exceeds the line's remaining quantity |
| `DUPLICATE_PRODUCT_IN_REQUIREMENT` | 409 | Duplicate product |
| `PURCHASE_ORDER_NOT_FOUND` | 404 | PO doesn't exist |
| `PURCHASE_ORDER_ITEM_NOT_FOUND` | 404 | PO item doesn't exist |
| `DUPLICATE_PO_NUMBER` | 409 | PO number exists |
| `PO_STATUS_TRANSITION_INVALID` | 409 | Invalid status change |
| `PO_CANNOT_CANCEL` | 409 | Cannot cancel received/closed |
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

### Purchase Requirement / Requirement Line
```
OPEN (nothing ordered)
  → PARTIALLY_FULFILLED (ordered < required)
  → FULFILLED (ordered >= required)
  → CLOSED (manual close; sticky)

Cancelling a PO releases its allocation, so affected lines drop back
(e.g. FULFILLED → PARTIALLY_FULFILLED or OPEN).
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