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

**List response includes a server-computed summary over the filtered dataset:**
```json
{
  "summary": {
    "open": "integer",
    "partiallyFulfilled": "integer",
    "fulfilled": "integer",
    "closed": "integer",
    "total": "integer"
  }
}
```

Requirement lines carry `unitId` and `quantityNeededBase` (normalized base
units). Ordered/fulfilled quantities are tracked in base units internally, so
"5 Boxes ≠ 5 Tablets" is always handled correctly even when the PO uses a
different unit than the requirement line.

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

---## 🛒 Purchase Orders

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
| `paymentStatus` | enum | No | `NOT_INVOICED`, `UNPAID`, `PARTIALLY_PAID`, `PAID`, `ALL` |
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
  "meta": { "page": "integer", "limit": "integer", "total": "integer", "totalPages": "integer" },
  "summary": {
    "registered": "integer",
    "awaitingDelivery": "integer",
    "received": "integer",
    "closed": "integer",
    "cancelled": "integer"
  }
}
```

`summary` counts are computed server-side over the **filtered** dataset (all
filters applied), not just the current page.

**New: Payment Status Filtering**

The `paymentStatus` query parameter filters POs by their derived payment state:

| Value | Description |
|-------|-------------|
| `NOT_INVOICED` | No invoices linked to this PO |
| `UNPAID` | Has invoices, nothing paid yet |
| `PARTIALLY_PAID` | Has invoices, some payments made |
| `PAID` | All invoiced amounts paid |
| `ALL` | Include all (default when not specified) |

Payment status is **derived** from invoice aggregates — never stored. The server computes it from `invoiceCount`, `invoicedAmount` (SUM of invoice totalAmount), and `outstandingAmount`.

**New: Unit-Aware PO Items**

PO items now carry unit information:

```json
{
  "id": "string (UUID)",
  "productId": "string (UUID)",
  "quantityOrdered": "number (3 decimals) — in the ordered unit",
  "unitId": "string|null — the unit the quantity is expressed in",
  "quantityOrderedBase": "number (3 decimals) — normalized to base unit for requirement reconciliation",
  "unitCost": "number (2 decimals)",
  ...
}
```

This enables cross-unit reconciliation: "5 Boxes ≠ 5 Tablets" is handled correctly when the PO uses a different unit than the requirement line.

**New: PO Detail Financial Summaries (GET /purchase-orders/:id):**

```json
{
  "receivingSummary": {
    "orderedQuantity": "number",
    "receivedQuantity": "number",
    "shortQuantity": "number",
    "remainingQuantity": "number"
  },
  "goodsSummary": {
    "orderedGoodsValue": "number — SUM(quantityOrdered × unitCost), commercial value of goods ordered",
    "receivedGoodsValue": "number — SUM(quantityReceived × unitCost), value of goods actually received",
    "goodsInvoicedAmount": "number — SUM(invoice item allocations), value of received goods already billed",
    "remainingGoodsToInvoice": "number — receivedGoodsValue − goodsInvoicedAmount"
  },
  "paymentSummary": {
    "status": "NOT_INVOICED | UNPAID | PARTIALLY_PAID | PAID",
    "invoiceCount": "integer",
    "invoicedAmount": "number — SUM(invoice.totalAmount), what the invoices bill in total",
    "paidAmount": "number — SUM(invoice payments)",
    "outstandingAmount": "number — invoicedAmount − paidAmount"
  }
}
```

These are **derived** values, never stored on the PO. Note that
`receivedGoodsValue` / `goodsInvoicedAmount` are goods concepts while
`invoicedAmount` / `paidAmount` / `outstandingAmount` are invoice-total
concepts — they are intentionally different numbers
(`invoicedAmount` can exceed `orderedGoodsValue` when tax/fees apply).
Payment status does not block invoicing of later deliveries: a fully-paid PO
with newly received goods simply shows `remainingGoodsToInvoice > 0`.

---### Create Purchase Order
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
      "requirementLineId": "string (UUID)|null",
      "unitId": "string|null (optional — defaults to product's base unit)"
    }
  ]
}
```
- Minimum 1 item required
- If `requirementLineId` is provided, an allocation is created linking the PO item to the
  requirement line. `productId` must match the line's product, the line must not be
  `CLOSED`, and `quantityOrdered` (converted to base units) must not exceed the line's remaining quantity
  (required − active allocations) or the request fails with `409 REQUIREMENT_QUANTITY_EXCEEDED`
  (details: `requiredQuantity`, `currentlyOrderedQuantity`, `remainingQuantity`, `requestedQuantity`)
- A requirement line can be fulfilled by several POs, even from different suppliers;
  cancelling a PO releases its allocation automatically
- Unit conversions: if `unitId` is provided, the quantity is converted to base units for allocation
  math. The allocation is stored in base units so requirements reconcile correctly across different units.

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

---### Get Purchase Order by ID
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
        "quantityOrdered": "number (3 decimals)",
        "quantityReceived": "number (3 decimals)",
        "quantityShort": "number (3 decimals)",
        "unitCost": "number (2 decimals)",
        "shortReason": "string|null",
        "unitId": "string|null",
        "quantityOrderedBase": "number (3 decimals)",
        "createdAt": "ISO8601 datetime",
        "updatedAt": "ISO8601 datetime",
        "product": { "id": "string", "name": "string", "sku": "string" },
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
    ],
    "receivingSummary": { ... },
    "goodsSummary": { ... },
    "paymentSummary": { ... }
  }
}
```

**New fields on PO items:**
- `quantityShort` — quantity accepted as short (not expected to be delivered)
- `shortReason` — optional reason for the shortage acceptance
- `unitId` — the unit this item was ordered in
- `quantityOrderedBase` — quantity normalized to base unit (for requirement reconciliation)

**Derived summaries attached to PO detail:**
- `receivingSummary` — ordered/received/short/remaining quantities
- `goodsSummary` — financial value of goods (ordered/received/invoiced/remaining)
- `paymentSummary` — invoice totals and payment status (derived from all invoices)

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

**Validates:** All items fully received OR accepted as short (`quantityReceived + quantityShort >= quantityOrdered`)

**Response 200:** Updated PO with `status: "CLOSED"`

**Error Responses:**
- `404 PURCHASE_ORDER_NOT_FOUND`
- `409 PO_STATUS_TRANSITION_INVALID` - Only from RECEIVED, or items not fully received/accounted for

---

### Accept Shortage on PO Item (NEW)
```
POST /purchase-orders/items/:itemId/accept-shortage
```

**Path Parameters:** `id` (UUID) - Purchase Order Item ID

**Purpose:** Accept that a PO item will be delivered short (partial delivery with acknowledged shortage). This is pure reconciliation — it never increases stock and never increments requirement fulfillment.

**Request Body:**
```json
{
  "quantityShort": "number (optional, >0, 3 decimals) — defaults to full remaining quantity",
  "shortReason": "string|null (max 500)"
}
```

**Rules:**
- PO must be in `REGISTERED` or `AWAITING_DELIVERY` status (not RECEIVED/CLOSED/CANCELLED)
- `quantityShort` must be > 0 (if provided)
- `received + short` cannot exceed `ordered` quantity
- If `quantityShort` not provided, defaults to: `ordered - received - existingShort`
- At least one of `quantityShort` or `shortReason` is required

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
- `409 PO_STATUS_TRANSITION_INVALID` - PO not in valid status (REGISTERED/AWAITING_DELIVERY)
- `422 BAD_REQUEST` - Invalid shortage quantity, or received + short would exceed ordered

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
  ],  "meta": { "page": "integer", "limit": "integer", "total": "integer", "totalPages": "integer" },
  "summary": {
    "matched": "integer",
    "discrepancy": "integer",
    "resolved": "integer"
  }
}
```

`summary` counts are computed server-side over the **filtered** dataset. Each
receipt item records the transaction `unitId` (the PO item's ordered unit), so
received quantities are interpreted in the correct unit and normalized to base
units when confirming into inventory.```
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
      "deliveredQty": "number (required, >=0, 3 decimals)",
      "actualQty": "number (required, >=0, 3 decimals)",
      "batchNumber": "string|null (max 100)",
      "manufacturingDate": "ISO8601 datetime|null",
      "expiryDate": "ISO8601 datetime|null"
    }
  ]
}
```
- Minimum 1 item required
- `purchaseOrderItemId` must belong to the PO
- **Updated quantity rules:** Quantities can be >= 0 (not strictly > 0)
  - If `actualQty > 0` AND `deliveredQty > 0`: `batchNumber` and `expiryDate` required
  - `actualQty` cannot exceed remaining quantity on PO item (`ordered - received - acceptedShort`)
- `expectedQty` auto-calculated from PO (ordered - received - acceptedShort)
- Each receipt item records `unitId` (the PO item's ordered unit) for unit consistency

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
- `422 GOODS_RECEIPT_BATCH_REQUIRED` - batchNumber required when actualQty > 0 and deliveredQty > 0
- `422 GOODS_RECEIPT_EXPIRY_REQUIRED` - expiryDate required when actualQty > 0 and deliveredQty > 0
- `422 GR_ITEM_QUANTITY_MISMATCH` - quantity validation failed (actualQty exceeds remaining, or actualQty must be > 0 when deliveredQty > 0)

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

---### Create Supplier Invoice (Major Update)
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
  "goodsAmount": "number (>0, 2 decimals) — required for non-PO invoices; derived from items for PO-linked invoices",
  "taxAmount": "number (>=0, 2 decimals, default 0)",
  "additionalChargesAmount": "number (>=0, 2 decimals, default 0)",
  "discountAmount": "number (>=0, 2 decimals, default 0)",
  "paymentTerms": "string|null (max 500)",
  "items": [
    {
      "purchaseOrderItemId": "string (UUID, required for PO-linked invoices)",
      "quantity": "number (>0, in the PO item's ordered unit)",
      "unitCost": "number (optional; defaults to the PO item's unitCost)"
    }
  ]
}
```

**New: Financial Split Model**

All money fields now use a split model (all values are additive, safe defaults):

```
goodsAmount           — value of received goods being billed
taxAmount             — tax amount (>= 0)
additionalChargesAmount — additional charges (>= 0)
discountAmount        — discount applied (>= 0)

totalAmount = goodsAmount + taxAmount + additionalChargesAmount - discountAmount
outstandingBalance = totalAmount - totalPayments
invoiceAmount = totalAmount  (legacy mirror for old consumers)
```

**Payment status is always based on `totalAmount`, never on `goodsAmount` or PO value.**

**New: PO-Linked Invoices with Allocation Tracking**

For PO-linked invoices (`purchaseOrderId` provided):

1. `items` is **REQUIRED** — must allocate to at least one PO item
2. Server derives `goodsAmount` from allocations: `SUM(quantity × unitCost)`
3. **Double-invoicing protection:** For each PO item, total invoiced across ALL invoices cannot exceed received quantity
   - Row locks on PO items make this safe under concurrent invoice creation
   - Error: `409 SUPPLIER_INVOICE_EXCEEDS_RECEIVED` with details: `purchaseOrderItemId`, `quantityReceived`, `alreadyInvoiced`, `requested`, `remainingGoodsToInvoice`
4. If `goodsAmount` is supplied, it must match the derived amount (no silent over-billing)
5. `unitCost` defaults to PO item's unitCost if not provided
6. Each invoice item records `unitId` (the PO item's ordered unit)

**Non-PO Invoices:**

1. `goodsAmount` is **REQUIRED** and must be > 0
2. `items` cannot be provided
3. `discountAmount` requires `goodsAmount` to be present

**Invoice Items Response Structure:**

```json
{
  "items": [
    {
      "id": "string (UUID)",
      "purchaseOrderItemId": "string (UUID)",
      "quantity": "number (invoiced quantity in PO item's ordered unit)",
      "unitId": "string|null (the unit this quantity is expressed in)",
      "unitCost": "number (2 decimals)",
      "goodsAmount": "number (quantity × unitCost)",
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
  ]
}
```

**Important Notes:**
- A PO whose invoice is fully paid can still receive more goods later; the new
  goods simply remain invoiceable (`remainingGoodsToInvoice` on the PO).
- `invoicedAmount` in PO payment summary = SUM(invoice.totalAmount), NOT goodsAmount
- `goodsInvoicedAmount` in PO goods summary = SUM(invoice items goodsAmount)

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
    "goodsAmount": "number (value of received goods being billed)",
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
- `409 SUPPLIER_INVOICE_EXCEEDS_RECEIVED` - Allocation exceeds received-but-not-yet-invoiced quantity (includes detailed breakdown)
- `422 BAD_REQUEST` - PO belongs to different supplier, negative total, missing items, goodsAmount mismatch, discount without goodsAmount

---

### Get Supplier Invoice by ID
```
GET /supplier-invoices/:id
```

**Path Parameters:** `id` (UUID)

**Response 200:** Invoice with full payment history and invoice items.

**Invoice items include:**
- `quantity` — invoiced quantity in PO item's ordered unit
- `unitId` — the unit this quantity is expressed in
- `unitCost` — unit cost used for this allocation
- `goodsAmount` — quantity × unitCost for this line
- Full `purchaseOrderItem` details including `product`, `quantityOrdered`, `quantityReceived`, and `unit` info
- Optional `unit` info (if unit is configured)

**Payments include:**
- Full payment details with `recordedBy` info

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

---### Record Payment (NEW: Concurrent-Safe)
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

**New: Concurrent Payment Protection**

Payment validation and update happen inside a transaction with a conditional update (`WHERE outstandingBalance >= amount`). This prevents two concurrent payments from jointly over-allocating the balance — the loser of the race matches zero rows and fails with `SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE`.

**Rules:**
- Validates: `amount <= outstandingBalance` (inside transaction)
- Auto-updates invoice `outstandingBalance` and `status` (OPEN → PARTIALLY_PAID → PAID)
- Payment amount must be > 0 and at most 2 decimal places

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
- `422 SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE` - Includes `outstanding` and `requested` in details

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
| `GR_ITEM_QUANTITY_MISMATCH` | 422 | Quantity validation failed (actualQty exceeds remaining, or actualQty must be > 0 when deliveredQty > 0) |
| `SUPPLIER_INVOICE_NOT_FOUND` | 404 | Invoice doesn't exist |
| `DUPLICATE_INVOICE_NUMBER` | 409 | Invoice number exists for supplier |
| `SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE` | 422 | Payment > outstanding (includes `outstanding` and `requested` in details) |
| `SUPPLIER_INVOICE_EXCEEDS_RECEIVED` | 409/422 | Invoice allocation exceeds received-but-not-invoiced quantity (includes `purchaseOrderItemId`, `quantityReceived`, `alreadyInvoiced`, `requested`, `remainingGoodsToInvoice` in details) |
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

## 🔄 Complete Status Flows### Purchase Order
```
REGISTERED → AWAITING_DELIVERY → RECEIVED → CLOSED
                    ↓
               CANCELLED (from REGISTERED or AWAITING_DELIVERY)

**New: Shortage Acceptance Flow**

A PO item can accept a shortage at any point while the PO is in REGISTERED or AWAITING_DELIVERY:

```
REGISTERED/AWAITING_DELIVERY
    └──[accept-shortage]──> quantityShort updated
                              └──> If ALL items fully accounted for (received + short >= ordered):
                                    └──> PO moves to RECEIVED
```

**Item Fully Accounted For:** `quantityReceived + quantityShort >= quantityOrdered`

Shortages are pure reconciliation:
- Never increase stock (no physical goods added)
- Never count toward requirement fulfillment
- Allow PO to progress to RECEIVED even when not everything was delivered

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

## 📝 Common Response Format**Success:**
```json
{
  "success": true,
  "data": { ... },
  "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
}
```

List endpoints may also return a `summary` object with server-computed counts
over the **filtered** dataset (never just the current page):

**Error:**```json
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

## 📦 Inventory & Product Summaries (units + counts)

### Unit model (used across the whole system)

Every product has exactly one **base unit** (`ProductUnit.isBaseUnit = true`)
plus optional larger units with a `conversionFactor` to base
(e.g. Box = 10 × Tablet). All internal quantity math — requirement
fulfillment, PO allocation, receiving, stock levels, POS deduction — is done
in **base units**; the display unit is preserved alongside.

Where unit snapshots live (never recalculated retroactively when
conversions change):
- `purchase_requirement_line`: `unitId`, `quantityNeededBase`
- `purchase_order_item`: `unitId`, `quantityOrderedBase` (unitCost is per this unit)
- `goods_receipt_item`: `unitId` (quantities are in the PO item's ordered unit)
- `stock_transaction`: `unitId`, `conversionFactor` (original transaction unit + base quantity)
- `sale_item` / `stock_transfer_item`: existing `quantity`/`baseQuantity`/`conversionFactor` snapshots (unchanged)
- POS sells in any sellable unit; stock is checked and deducted in base units
  (`availableBaseStock >= quantity × conversionFactor`), so 2 Boxes correctly
  deduct 20 Tablets.

### GET /products — summary counts
```json
{
  "summary": {
    "byStatus": { "active": 320, "inactive": 25 },
    "byProductGroup": [
      { "productGroupId": "uuid", "productGroupName": "Antibiotics", "count": 80 }
    ]
  }
}
```
Counts respect the endpoint's filters (search / group / status / brand).

### GET /stock — location summary
```json
{
  "summary": {
    "byLocation": [
      { "locationId": "uuid", "locationName": "Main Pharmacy", "itemCount": 240 }
    ]
  }
}
```
`itemCount` = distinct **stock rows with quantity > 0** per location (i.e.
product/batch combinations actually in stock), over the filtered dataset.
Stock quantities are always in the product's base unit.

### GET /requirements — fulfillment summary
```json
{
  "summary": { "open": 12, "partiallyFulfilled": 5, "fulfilled": 8, "closed": 20, "total": 45 }
}
```
Counts are derived from stored requirement status, which itself reflects
ordered/fulfilled base-quantity progress.

### GET /goods-receipts — status summary
```json
{
  "summary": { "matched": 30, "discrepancy": 8, "resolved": 7 }
}
```

### GET /purchase-orders — status summary
```json
{
  "summary": { "registered": 10, "awaitingDelivery": 8, "received": 15, "closed": 20, "cancelled": 2 }
}
```
---

## 🔄 Backend Upgrade — Financial Concepts, Unit Consistency & API Summary Counts

### Overview

This upgrade introduces three major architectural improvements to the purchasing domain:

1. **Financial Concepts Separation** — Clear distinction between goods value and invoice total
2. **Unit Consistency** — All purchasing quantities now track their unit for cross-unit reconciliation
3. **API Summary Counts** — All list endpoints return server-computed summaries over filtered datasets

---

### 1. Financial Concepts Separation

#### The Problem

Previously, invoices only tracked a single `invoiceAmount`. This conflated:
- The value of physical goods being billed
- Tax, shipping, and other charges
- Discounts applied

This made it impossible to answer questions like:
- "How much of our inventory value has been billed?"
- "What's the tax amount on this invoice?"
- "What are the shipping charges?"

#### The Solution

**Supplier Invoices now have a full financial split:**

| Field | Type | Description |
|-------|------|-------------|
| `goodsAmount` | Decimal(12,2) | Value of received goods being billed |
| `taxAmount` | Decimal(12,2) | Tax amount (>= 0) |
| `additionalChargesAmount` | Decimal(12,2) | Shipping, handling, etc. (>= 0) |
| `discountAmount` | Decimal(12,2) | Discount applied (>= 0) |
| `totalAmount` | Decimal(12,2) | **Final invoice total** = goods + tax + charges - discount |
| `invoiceAmount` | Decimal(12,2) | **Legacy mirror** of totalAmount (for backward compatibility) |

**Key Principles:**

1. **Payment status is based on `totalAmount`, never `goodsAmount`**
   - An invoice with $100 goods + $10 tax = $110 total
   - Paying $110 marks it PAID, not $100

2. **PO payment summary uses invoice totals, not goods amounts**
   - `invoicedAmount` on PO = SUM(invoice.totalAmount)
   - This can exceed `orderedGoodsValue` when tax/fees apply

3. **PO goods summary tracks physical goods separately**
   - `orderedGoodsValue` = SUM(quantityOrdered × unitCost)
   - `receivedGoodsValue` = SUM(quantityReceived × unitCost)
   - `goodsInvoicedAmount` = SUM(invoice item goodsAmount)
   - `remainingGoodsToInvoice` = receivedGoodsValue - goodsInvoicedAmount

4. **A fully-paid PO can still have invoiceable goods**
   - If new goods are received after the invoice is paid, `remainingGoodsToInvoice > 0`
   - These goods can be invoiced on a new invoice

---

### 2. Unit Consistency Across Purchasing

#### The Problem

Previously, all quantities were stored as simple numbers with no unit context:
- A requirement line for "5 Boxes" and a PO for "100 Tablets" couldn't reconcile
- If units were reconfigured, historical data would be reinterpreted incorrectly
- Requirement fulfillment math was ambiguous

#### The Solution

**Every quantity in the purchasing domain now carries its unit:**

**Database Changes:**

| Table | New Columns | Purpose |
|-------|-------------|---------|
| `purchase_requirement_line` | `unitId`, `quantityNeededBase` | Track unit for requirement, store base-unit snapshot |
| `purchase_order_item` | `unitId`, `quantityOrderedBase` | Track unit for order, store base-unit snapshot |
| `goods_receipt_item` | `unitId` | Track unit for receipt (copied from PO item) |
| `stock_transaction` | `unitId`, `conversionFactor` | Track unit for stock movements |
| `supplier_invoice_item` | `unitId` | Track unit for invoice allocation |

**How It Works:**

1. **Unit-Aware Quantities**
   - Each item stores `quantity` in its ordered/delivered unit
   - Each item also stores `quantityBase` — the quantity normalized to the product's base unit
   - Example: Order "5 Boxes" where 1 Box = 12 Tablets → `quantityOrdered = 5`, `quantityOrderedBase = 60`

2. **Base Unit Reconciliation**
   - Requirement fulfillment compares `quantityOrderedBase` against `quantityNeededBase`
   - This ensures "5 Boxes" and "60 Tablets" reconcile correctly even if ordered in different units
   - Rule: **"5 Boxes ≠ 5 Tablets" is always handled correctly**

3. **Conversion Snapshot**
   - `quantityBase` is captured at the time of order/receipt
   - Later unit reconfiguration never reinterprets historical data
   - The base quantity is immutable once set

4. **Unit Derivation**
   - If `unitId` is not provided, defaults to the product's base unit
   - For requirement-linked orders, the unit comes from the requirement line (or product base unit)
   - For invoice items, the unit comes from the PO item being invoiced

---

### 3. API Summary Counts

#### The Problem

Previously, summary counts (e.g., "how many POs are in each status?") were either:
- Not available
- Computed only on the current page (misleading when paginated)
- Required separate API calls

#### The Solution

**All list endpoints now return a `summary` object with server-computed counts over the FILTERED dataset:**

**Purchase Orders:**
```json
{
  "summary": {
    "registered": 10,
    "awaitingDelivery": 5,
    "received": 3,
    "closed": 2,
    "cancelled": 1
  }
}
```

**Goods Receipts:**
```json
{
  "summary": {
    "matched": 15,
    "discrepancy": 2,
    "resolved": 3
  }
}
```

**Purchase Requirements:**
```json
{
  "summary": {
    "open": 8,
    "partiallyFulfilled": 4,
    "fulfilled": 6,
    "closed": 2,
    "total": 20
  }
}
```

**Key Points:**

- Counts are computed over the **filtered dataset** (all query filters applied)
- Not just the current page — reflects the entire result set
- Computed in the same database transaction as the paginated results
- Enables UI dashboards to show accurate status distributions without extra API calls

---

### Database Schema Changes

#### Migration: 2026-09-21 — PO Shortage and Payment Status

```sql
-- Accepted shortage on purchase order items
ALTER TABLE "purchase_order_item" ADD COLUMN "quantityShort" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_order_item" ADD COLUMN "shortReason" TEXT;

-- Index supporting PO -> invoices aggregation and payment-status filtering
CREATE INDEX "supplier_invoice_purchaseOrderId_idx" ON "supplier_invoice"("purchaseOrderId");
```

#### Migration: 2026-09-22 — Financial Split & Unit Tracking

```sql
-- Financial split on supplier invoices (all additive, safe defaults)
ALTER TABLE "supplier_invoice" ADD COLUMN "goodsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "additionalChargesAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_invoice" ADD COLUMN "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
-- Historical rows had no split: goods = total, tax/charges/discount = 0
UPDATE "supplier_invoice" SET "totalAmount" = "invoiceAmount", "goodsAmount" = "invoiceAmount";

-- Goods allocation per invoice (prevents double-invoicing received goods)
CREATE TABLE "supplier_invoice_item" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitId" TEXT,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "goodsAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_invoice_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_invoice_item_invoiceId_purchaseOrderItemId_key" 
    ON "supplier_invoice_item"("invoiceId", "purchaseOrderItemId");
CREATE INDEX "supplier_invoice_item_purchaseOrderItemId_idx" 
    ON "supplier_invoice_item"("purchaseOrderItemId");
CREATE INDEX "supplier_invoice_item_invoiceId_idx" 
    ON "supplier_invoice_item"("invoiceId");
ALTER TABLE "supplier_invoice_item" ADD CONSTRAINT "supplier_invoice_item_invoiceId_fkey" 
    FOREIGN KEY ("invoiceId") REFERENCES "supplier_invoice"("id") 
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_invoice_item" ADD CONSTRAINT "supplier_invoice_item_purchaseOrderItemId_fkey" 
    FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_item"("id") 
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unit consistency across purchasing (

ALTER TABLE "stock_transaction" ADD COLUMN "conversionFactor" DECIMAL(12,4);

ALTER TABLE "purchase_requirement_line" ADD CONSTRAINT "purchase_requirement_line_unitId_fkey" 
    FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_unitId_fkey" 
    FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_item" ADD CONSTRAINT "goods_receipt_item_unitId_fkey" 
    FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_unitId_fkey" 
    FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill base snapshots for legacy rows (null unitId = base unit, factor 1)
UPDATE "purchase_requirement_line" SET "quantityNeededBase" = "quantityNeeded" WHERE "unitId" IS NULL;
UPDATE "purchase_order_item" SET "quantityOrderedBase" = "quantityOrdered" WHERE "unitId" IS NULL;
```

#### Migration: 2026-09-22 — Supplier Invoice Item Unit FK

```sql
-- Add missing relation from supplier_invoice_item.unitId to unit
ALTER TABLE "supplier_invoice_item" ADD CONSTRAINT "supplier_invoice_item_unitId_fkey" 
    FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

---

## 🔄 Purchasing Domain Refactor — Receiving, Shortages, Multiple POs, Invoices & PO Payment Status

### Overview

This refactor fundamentally improves how the purchasing domain handles:
1. **Receiving** — Goods receipts now properly track what was actually delivered vs ordered
2. **Shortages** — Explicit shortage acceptance allows POs to complete even with partial delivery
3. **Multiple POs per Requirement** — A requirement line can be fulfilled by multiple POs from different suppliers
4. **Invoices** — Full allocation tracking prevents double-invoicing of received goods
5. **PO Payment Status** — Derived payment status gives clear visibility into PO financial state

---

### 1. Receiving & Quantity Tracking

#### What Changed

**Goods receipts now track more granular quantity information:**

| Field | Description |
|-------|-------------|
| `expectedQty` | What we expected to receive (ordered - received - acceptedShort) |
| `deliveredQty` | What the supplier delivered (per their delivery) |
| `actualQty` | What we're actually accepting into inventory |
| `unitId` | The unit this quantity is expressed in (from PO item) |

**Quantity Validation Rules (Updated):**

- Quantities can now be >= 0 (previously required > 0)
- This allows recording a delivery where nothing was actually received (deliveredQty > 0, actualQty = 0)
- Batch/expiry requirements only apply when BOTH actualQty > 0 AND deliveredQty > 0
- `actualQty` cannot exceed `expectedQty` (remaining on PO item)

**Expected Quantity Calculation:**

```
expectedQty = quantityOrdered - quantityReceived - quantityShort
```

Accepted shortages reduce the expected quantity because those units are never coming.

---

### 2. Shortage Acceptance

#### What Changed

**New endpoint: `POST /purchase-orders/items/:itemId/accept-shortage`**

This allows explicitly acknowledging that a PO item will not be fully delivered:

**Use Cases:**
- Supplier communicates they can only deliver partial quantity
- Damage in transit — some units unusable
- Agreement with supplier on reduced quantity

**How It Works:**

1. Caller specifies `quantityShort` (or leaves blank for full remaining)
2. System validates: `received + short <= ordered`
3. `quantityShort` and optional `shortReason` are stored on the PO item
4. If ALL items on the PO are now fully accounted for, PO moves to RECEIVED

**Shortage Implications:**

- **Stock:** Shortages never increase stock (no physical goods)
- **Requirements:** Shortages never count toward requirement fulfillment
  - The allocation remains "active" but the effective committed quantity is reduced
  - This frees up capacity on the requirement line for other suppliers
- **PO Status:** PO can progress to RECEIVED once all items are accounted for (received + short >= ordered)
- **Invoicing:** Only actual received goods can be invoiced, not shortages

---

### 3. Multiple POs per Requirement Line

#### What Changed

**A requirement line can now be fulfilled by multiple POs, even from different suppliers.**

**Previous Behavior:**
- A requirement line could only be linked to one PO item
- If that PO was cancelled, the allocation was lost
- No way to split a large requirement across multiple suppliers

**New Behavior:**

- Multiple POs can allocate against the same requirement line
- Each PO's allocation is tracked independently
- Total ordered = SUM of all active allocations (POs not CANCELLED)
- Cancelling a PO automatically releases its allocation and recomputes requirement status

**Allocation Math:**

```
quantityOrdered (on requirement line) = SUM(quantityAllocated) for all active allocations

where "active" means the PO is not in CANCELLED status
```

**Concurrency Safety:**

- Row-level locks on requirement lines during order creation
- Ensures `SUM(active allocations) <= requiredQuantity` under concurrent orders
- Lines are locked in sorted order to prevent deadlocks

**Example Scenario:**

```
Requirement Line: Product A, quantityNeeded = 100 Units

PO #1 (Supplier X): allocates 40 Units → active allocation = 40
PO #2 (Supplier Y): allocates 30 Units → active allocation = 70 total
PO #3 (Supplier X): tries to allocate 40 Units → FAILS (only 30 remaining)

PO #1 cancelled: active allocation drops to 30 (from PO #2 only)
PO #3 now succeeds with 30 Units
```

---

### 4. Invoice Allocation & Double-Invoicing Protection

#### What Changed

**New: Invoice items with allocation tracking**

Previously, invoices could be created without precise allocation to received goods.
Now, PO-linked invoices MUST allocate their goods to specific PO items.

**How It Works:**

1. **Invoice Creation**
   - For PO-linked invoices, `items` array is required
   - Each item specifies: `purchaseOrderItemId`, `quantity`, optional `unitCost`
   - Server validates: `alreadyInvoiced + newQuantity <= quantityReceived`
   - Server derives `goodsAmount` = `SUM(quantity × unitCost)`

2. **Double-Invoicing Protection**
   - Row-level locks on PO items during invoice creation
   - Aggregates already-invoiced quantities across ALL invoices for the PO
   - Prevents the same received goods from being invoiced twice
   - Even under concurrent invoice creation, the lock ensures consistency

3. **Allocation Tracking**
   - Each invoice item stores: `quantity`, `unitId`, `unitCost`, `goodsAmount`
   - Unique constraint: `(invoiceId, purchaseOrderItemId)` — can't allocate same PO item twice in one invoice
   - Index on `purchaseOrderItemId` for efficient aggregation

**Error Response Example:**

```json
{
  "success": false,
  "error": {
    "code": "SUPPLIER_INVOICE_EXCEEDS_RECEIVED",
    "message": "Invoiced quantity exceeds the received-but-not-yet-invoiced quantity",
    "details": {
      "purchaseOrderItemId": "abc-123",
      "quantityReceived": 50,
      "alreadyInvoiced": 40,
      "requested": 20,
      "remainingGoodsToInvoice": 10
    }
  }
}
```

**Business Rule:**

> Received goods can only be invoiced once. If you need to invoice more, receive more first.
> A PO whose invoice is fully paid can still receive more goods — those new goods simply
> remain invoiceable on future invoices.

---

### 5. PO Payment Status (Derived)

#### What Changed

**PO payment status is now a derived value, not stored.**

**Why Derived?**

- Stored status can go stale if invoices/payments are modified externally
- Derived status always reflects current state of all invoices and payments
- No need to update PO when invoices change — status is computed on read

**Payment Status Values:**

| Status | Condition | Meaning |
|--------|-----------|---------|
| `NOT_INVOICED` | `invoiceCount = 0` | No invoices created for this PO yet |
| `UNPAID` | `invoiceCount > 0` AND `outstanding > 0` AND `paid = 0` | Invoices exist, nothing p


---

## Summary of Business Rules

1. **Requirement Fulfillment**
   - Based on ordered quantity (active allocations), not received quantity
   - Receiving updates `quantityDelivered` but does not change fulfillment status
   - Cancelling a PO releases its allocation automatically

2. **Shortage Handling**
   - Shortages are explicitly accepted, never implicit
   - Shortages reduce effective allocation (free up requirement capacity)
   - Shortages never increase stock or count toward fulfillment
   - PO can complete (RECEIVED) with shortages accepted

3. **Invoice Allocation**
   - PO-linked invoices MUST allocate to specific PO items
   - Received goods can only be invoiced once (double-invoicing protection)
   - Goods amount is derived from allocations, not client-provided (must match if provided)

4. **Payment Tracking**
   - Payment status is derived from invoice/payment aggregates
   - Payments are applied to invoice total, not goods amount
   - Fully-paid PO can still have invoiceable goods (new receipts)

5. **Unit Consistency**
   - All quantities track their unit
   - Base unit snapshots ensure historical consistency
   - Cross-unit reconciliation uses base units (5 Boxes = 60 Tablets)


---

## 📦 Stock & Inventory Types for Integration

### StockMovementInput (Used by stock movement operations)

```typescript
type StockMovementInput = {
  productId: string;
  batchId: string;
  locationId: string;
  transactionType: StockTransactionType;  // e.g., "OPENING", "PURCHASE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "RETURN_TO_SUPPLIER", "TRANSFER"
  direction: StockDirection;              // "IN" | "OUT"
  /** Positive quantity expressed in the product's BASE unit. */
  quantity: Prisma.Decimal | number | string;
  /**
   * Optional conversion snapshot: the unit the originating transaction was
   * entered in and the factor used to normalize to base units. Purely
   * historical — `quantity` is always base units regardless.
   */
  unitId?: string | null;
  conversionFactor?: Prisma.Decimal | number | null;
  referenceType?: string | null;
  referenceId?: string | null;
  notes?: string | null;
  actor: Pick<AuthenticatedUser, "id">;
};
```

**Key Points:**
- `quantity` is ALWAYS in base units (not the display unit)
- `unitId` and `conversionFactor` are for historical traceability only
- Example: If you enter "5 Boxes" where 1 Box = 12 Tablets, you pass:
  - `quantity: 60` (base units = tablets)
  - `unitId: "box-uuid"` (the box unit)
  - `conversionFactor: 12` (1 box = 12 tablets)

---

### Stock Service Inputs

#### OpeningStockInput
```typescript
type OpeningStockInput = {
  productId: string;
  batchId: string;
  locationId: string;
  /** Quantity expressed in the unit identified by `unitId`. */
  quantity: number;
  unitId: string;
  notes?: string;
};
```

#### StockAdjustmentInput
```typescript
type StockAdjustmentInput = {
  productId: string;
  batchId: string;
  locationId: string;
  direction: StockDirection;  // "IN" | "OUT"
  quantity: number;
  unitId: string;
  reason: string;
};
```

**Note:** Both inputs accept `quantity` in the specified `unitId` unit, and the service converts to base units internally.

---

### Stock List Query

```typescript
type ListStockQuery = PageQuery & {
  productId?: string;
  batchId?: string;
  locationId?: string;
  search?: string;
};
```

**Response includes summary:**
```json
{
  "summary": {
    "byLocation": [
      {
        "locationId": "uuid",
        "locationName": "Main Pharmacy",
        "itemCount": 240
      }
    ]
  }
}
```

`itemCount` = distinct stock rows with quantity > 0 per location (product/batch combinations actually in stock).

---

### Dashboard Types

#### DashboardSummary
```typescript
type DashboardSummary = {
  sales: {
    today: number;           // Today's revenue
    transactions: number;    // Today's transaction count
    averageTransaction: number;
  };
  inventory: {
    stockValue: number;      // SUM(stock × base_unit.purchasePrice)
    lowStockCount: number;
    outOfStockCount: number;
    expiringSoonCount: number;  // Within 30 days
    expiredCount: number;
  };
  purchasing: {
    openRequirements: number;
    awaitingDelivery: number;
    partiallyReceived: number;  // POs with quantityReceived > 0 but not fully received
    outstandingInvoices: number; // OPEN + PARTIALLY_PAID invoices
  };
  slowMoving: {
    flaggedCount: number;
  };
};
```

#### Dashboard Attention Items

```typescript
type LowStockItem = {
  productId: string;
  productName: string;
  sku: string;
  availableStock: number;
  reorderPoint: number;
};

type ExpiringSoonItem = {
  batchId: string;
  productId: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;        // ISO8601
  remainingQuantity: number; // 3 decimals
};

type AwaitingDeliveryItem = {
  purchaseOrderId: string;
  poNumber: string;
  supplierName: string;
  expectedDeliveryDate: string | null;  // ISO8601
};

type OutstandingInvoiceItem = {
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  outstandingBalance: number;  // 2 decimals
  dueDate: string | null;      // ISO8601
};
```

**Dashboard endpoints return max 5 items per category.**

---

### Products with Unit Configuration

#### CreateProductInput
```typescript
type ProductUnitConfigInput = {
  /** Id of a reusable master Unit (e.g. "Box"). */
  unitId: string;
  /** How many base units one of these units equals. Base unit must be 1. */
  conversionFactor: number;
  sellPrice?: number;
  purchasePrice?: number;
  isBaseUnit?: boolean;
};

type CreateProductInput = {
  name: string;
  genericName?: string;
  brand?: string;
  sku: string;
  productGroupId: string;
  description?: string;
  imageUrl?: string;
  minimumStock?: number;
  reorderPoint?: number;
  isActive?: boolean;
  /**
   * Optional embedded unit configuration created atomically with the product.
   * Exactly one entry must be the base unit (conversionFactor = 1).
   * When omitted, the product is created without units (legacy flow).
   */
  units?: ProductUnitConfigInput[];
};
```

**Unit Validation Rules:**
- At least one unit configuration required if `units` provided
- Exactly one base unit (conversionFactor = 1)
- No duplicate units
- All units must exist and be active
- Non-base conversion factors must be > 0

---

### Product Response with Units

```json
{
  "id": "uuid",
  "name": "Product Name",
  "sku": "SKU-123",
  "isActive": true,
  "minimumStock": 10,
  "reorderPoint": 20,
  "productGroup": { "id": "uuid", "name": "Group Name" },
  "baseUnit": { "id": "uuid", "name": "Tablet", "symbol": "tab" },
  "units": [
    {
      "id": "uuid",
      "unit": { "id": "uuid", "name": "Box", "symbol": "box", "isActive": true },
      "conversionFactor": 12,
      "sellPrice": 120.00,
      "purchasePrice": 80.00,
      "isBaseUnit": false
    },
    {
      "id": "uuid",
      "unit": { "id": "uuid", "name": "Tablet", "symbol": "tab", "isActive": true },
      "conversionFactor": 1,
      "sellPrice": 10.00,
      "purchasePrice": 6.67,
      "isBaseUnit": true
    }
  ],
  "stockSummary": {
    "stockStatus": "IN_STOCK",  // "OUT_OF_STOCK" | "LOW_STOCK" | "IN_STOCK"
    "totalQuantity": 150,       // in base units
    "byLocation": [
      { "locationId": "uuid", "locationName": "Main", "quantity": 100 }
    ]
  },
  "batchCount": 3,
  "transactionCount": 45,
  "locationCount": 2
}
```

---

### API Response Envelope (All Endpoints)

**Success Response:**
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  },
  "summary": { ... }  // Optional: server-computed aggregates over FILTERED dataset
}
```

**Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { ... }  // Optional: additional context (varies by error)
  }
}
```

**Key Points:**
- All list endpoints return `meta` with pagination info
- Many list endpoints also return `summary` with counts over the FILTERED dataset (not just current page)
- `summary` enables dashboards to show accurate status distributions without extra API calls

---

### Environment Configuration

```typescript
type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  port: number;              // default 4000
  host: string;              // default "0.0.0.0"
  databaseUrl: string;
  betterAuth: {
    secret: string;
    url: string;
  };
  google: {
    clientId: string;
    clientSecret: string;
  };
  frontendUrl: string;
  corsOrigins: string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  bodyLimit: string;        // default "100kb"
  cookieSecure: boolean;
  apiPrefix: "/api/v1";
  authBasePath: "/api/auth";
};
```

---

### Error Codes Summary

For a complete list, see the Error Codes Reference section above. Key purchasing-related codes:

| Code | HTTP | When |
|------|------|------|
| `REQUIREMENT_QUANTITY_EXCEEDED` | 409 | Order exceeds remaining quantity (includes details: requiredQuantity, currentlyOrderedQuantity, remainingQuantity, requestedQuantity) |
| `SUPPLIER_INVOICE_EXCEEDS_RECEIVED` | 409/422 | Invoice exceeds received goods (includes: purchaseOrderItemId,
| `SUPPLIER_INVOICE_EXCEEDS_RECEIVED` | 409/422 | Invoice exceeds received goods (includes: purchaseOrderItemId, quantityReceived, alreadyInvoiced, requested, remainingGoodsToInvoice) |
| `GR_ITEM_QUANTITY_MISMATCH` | 422 | Quantity validation failed |
| `SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE` | 422 | Payment exceeds outstanding (includes: outstanding, requested) |
| `INSUFFICIENT_STOCK` | 409 | Not enough stock for OUT movement (includes: available) |
| `BATCH_PRODUCT_MISMATCH` | 422 | Batch does not belong to product |
| `EXPIRED_BATCH` | 409 | Cannot add to expired batch |

---

### Integration Checklist

When integrating with the frontend, ensure:

1. **Authentication:** All requests require Better Auth session cookie (login at `POST /api/auth/sign-in/email`)

2. **Role-based access:** Purchasing endpoints require ADMIN role

3. **Unit handling:**
   - Always pass quantities in the correct unit
   - The API converts to base units internally for storage
   - Response quantities may be in different units than requested

4. **Financial calculations:**
   - PO `paymentSummary.invoicedAmount` is NOT equal to `goodsSummary.goodsInvoicedAmount`
   - Invoice `totalAmount` = goods + tax + charges - discount
   - Payment status based on `totalAmount`, not `goodsAmount`

5. **Pagination:** All list endpoints support `page` and `limit` query params

6. **Summaries:** Use the `summary` object for dashboard counts (not calculated client-side)

7. **Concurrency:** Payment recording is concurrent-safe (do not double-pay)

8. **Double-invoicing:** PO-linked invoices must include `items` array; same goods cannot be invoiced twice

