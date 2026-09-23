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

