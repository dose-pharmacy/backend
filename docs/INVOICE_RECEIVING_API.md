# Invoice-Upload-Assisted Receiving API

**Base URL:** `http://localhost:4000/api/v1/purchasing`
**Authentication:** Better Auth session cookie
**Content-Type:** `application/json`
**All endpoints require ADMIN role**

---

## What this is

A thin **orchestration layer** on top of the existing receiving system. It lets a
user pick an existing Purchase Order, supply the (already extracted) supplier
invoice, review a read-only receiving preview, then confirm — at which point the
backend creates a Goods Receipt, confirms it (batches + stock movements + PO
quantities) and creates the linked Supplier Invoice, **all through the same
canonical services used by the manual web form**:

```
POST /purchase-orders/:id/invoice-upload          (preview, read-only)
POST /purchase-orders/:id/invoice-upload/confirm  (atomic, 201)
```

The uploaded invoice is a **helper input**, never the authority over inventory.
The selected PO is the source of truth for expected products and quantities.

> **OCR gap.** This repository has no OCR/file-storage service. These endpoints
> therefore accept the **already-extracted, normalized invoice JSON** (the
> frontend runs OCR and posts the result, optionally after the user corrected
> values). The service never trusts the extracted values: it re-matches and
> re-validates everything from scratch, and re-derives them again at
> confirmation time. A real OCR adapter plugs in *in front of* this API.

---

## Flow

```
Selected Purchase Order
        ↓
POST /purchase-orders/:id/invoice-upload        ← preview (mutates nothing)
        ↓
match invoice lines against PO items
validate against CURRENT remaining quantities
        ↓
{ items, discrepancies, canConfirm }
        ↓
User confirms/corrects
        ↓
POST /purchase-orders/:id/invoice-upload/confirm
        ↓
[one transaction]
  lock PO items (FOR UPDATE)
  rebuild + re-validate plan against locked state
  goodsReceiptService.create   → Goods Receipt
  goodsReceiptService.confirm  → batches + StockTransaction + PO quantities
  supplierInvoiceService.create → Supplier Invoice
  audit INVOICE_RECEIVING_CONFIRMED
        ↓
{ purchaseOrder, goodsReceipt, supplierInvoice, receiving }
```

---

## Request body (both endpoints)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `locationId` | UUID | Yes | Default receiving location for all lines |
| `invoiceNumber` | string | Yes | Supplier invoice number (`SupplierInvoice.invoiceNumber`) |
| `invoiceDate` | ISO8601 | No | Invoice date |
| `grandTotal` | number | No | Supplier document grand total (stored as-is) |
| `supplierName` | string | No | Informational only — the PO's supplier is authoritative |
| `documentUrl` | string | No | Locator of the uploaded invoice document |
| `receivedDate` | ISO8601 | No | Receiving date (defaults to now) |
| `discrepancyNote` | string | No* | Required when documented ≠ physically accepted |
| `items[]` | array | Yes | At least one line |

### `items[]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `quantity` | number | Yes | **Documented / invoice** quantity for the line |
| `acceptedQuantity` | number | No | **Physically accepted** quantity (defaults to `quantity`) |
| `purchaseOrderItemId` | UUID | No | User-confirmed match (overrides server-side matching) |
| `productCode` | string | No | SKU / product code from the invoice |
| `productName` | string | No | Free-text product name |
| `unit` | string | No | Unit name/symbol as printed on the invoice |
| `unitPrice` | number | No | Invoice unit price (informational; never overwrites PO cost) |
| `batchNumber` | string | No* | Required to receive (`MISSING_BATCH` otherwise) |
| `expiryDate` | ISO8601 | No* | Required to receive (`MISSING_EXPIRY` otherwise) |
| `manufacturingDate` | ISO8601 | No | Passed through to the batch |
| `locationId` | UUID | No | Per-line location override |

`*` Required for any line with `acceptedQuantity > 0`.

**The supplier is never taken from the body** — it is always the selected PO's
supplier. Likewise `poId`, `productId` and `batchId` are derived server-side.

---

## Preview — `POST /purchase-orders/:id/invoice-upload`

Read-only. Matches the invoice against the PO and returns the receiving draft
with the **current** remaining quantities and any discrepancies. **Mutates
nothing** — no goods receipt, no stock, no invoice.

**Response 200:** `sendSuccess` envelope with:

```json
{
  "success": true,
  "data": {
    "purchaseOrder": {
      "id": "string (UUID)",
      "poNumber": "string",
      "status": "AWAITING_DELIVERY|RECEIVED",
      "supplier": { "id": "string", "name": "string" }
    },
    "receiving": { "locationId": "string (UUID)", "receivedDate": "ISO8601" },
    "invoice": {
      "invoiceNumber": "string",
      "invoiceDate": "ISO8601|null",
      "grandTotal": "number|null",
      "supplierName": "string|null",
      "documentUrl": "string|null"
    },
    "items": [
      {
        "lineIndex": "integer",
        "matched": "boolean",
        "purchaseOrderItemId": "string (UUID)|null",
        "product": { "id": "string", "name": "string", "sku": "string|null" },
        "unit": { "id": "string", "name": "string", "symbol": "string|null" } ,
        "invoiceQuantity": "number — documented quantity",
        "purchaseQuantity": "number — documented quantity",
        "acceptedQuantity": "number — physically accepted",
        "poOrdered": "number",
        "poReceived": "number",
        "poShort": "number",
        "poRemaining": "number — ordered − received − acceptedShortage",
        "remainingAfterReceipt": "number",
        "batchNumber": "string|null",
        "expiryDate": "ISO8601|null",
        "manufacturingDate": "ISO8601|null",
        "unitPrice": "number|null",
        "poUnitCost": "number|null"
      }
    ],
    "discrepancies": [
      { "code": "string", "message": "string", "blocking": "boolean", "lineIndex": "integer?", "purchaseOrderItemId": "string?", "details": {} }
    ],
    "canConfirm": "boolean",
    "requiresDiscrepancyNote": "boolean"
  }
}
```

### Matching rules

An invoice line is matched to a PO item by, in order:

1. explicit `purchaseOrderItemId` (user-confirmed),
2. `productCode` against the product **SKU**,
3. normalized `productName` against product **name / genericName / brand**
   (case- and whitespace-insensitive).

An unmatched line is **left unmatched**; the flow never creates a product.

### Current remaining quantity

```
remaining = quantityOrdered − quantityReceived − quantityShort
```

Computed from the **current** PO state, never from invoice/OCR history. The
aggregate accepted quantity across all lines (batches) for one PO item must not
exceed its remaining quantity.

### Discrepancy codes

| Code | Blocking | Meaning |
|------|----------|---------|
| `UNMATCHED_INVOICE_ITEM` | Yes | Line could not be matched to a PO item |
| `INVOICE_QUANTITY_EXCEEDS_PO_REMAINING` | Yes | Accepted qty > current remaining |
| `INVOICE_UNIT_MISMATCH` | Yes | Printed unit ≠ PO item's ordered unit (no conversion invented) |
| `MISSING_BATCH` | Yes | No batch number for a received line |
| `MISSING_EXPIRY` | Yes | No expiry date for a received line |
| `DUPLICATE_INVOICE_NUMBER` | Yes | Same supplier + invoice number already recorded |
| `PHYSICAL_DISCREPANCY` | Yes (until a note is supplied) | Documented ≠ physically accepted |
| `PRICE_DIFFERENCE` | No | Invoice unit price ≠ PO unit cost (informational) |

`canConfirm` is `true` only when no blocking discrepancy remains.

---

## Confirm — `POST /purchase-orders/:id/invoice-upload/confirm`

Same body. Runs inside **one transaction** (`timeout: 60s`, `maxWait: 15s`):

1. Loads + validates the PO (not `CANCELLED`/`CLOSED`, supplier active).
2. Locks every PO item: `SELECT id … WHERE "purchaseOrderId" = $1 ORDER BY id FOR UPDATE`.
3. **Rebuilds and re-validates the plan** against the locked current state —
   preview values are never trusted.
4. `goodsReceiptService.create` → Goods Receipt (created + confirmed via the
   canonical service).
5. If the receipt is a `DISCREPANCY` receipt, a `discrepancyNote` is required,
   then it is marked `RESOLVED`.
6. `goodsReceiptService.confirm` → batches + `StockTransaction` + `quantityReceived`
   + PO status.
7. `supplierInvoiceService.create` → Supplier Invoice (allocation capped at
   received-but-not-invoiced).
8. Records audit `INVOICE_RECEIVING_CONFIRMED`.

Any failure rolls the **whole** operation back — no partial goods receipt, no
orphan stock movement, no invoice.

**Response 201:**

```json
{
  "success": true,
  "data": {
    "purchaseOrder": { "id": "string", "poNumber": "string", "status": "AWAITING_DELIVERY|RECEIVED" },
    "goodsReceipt": { "...goods receipt + items (batches)" },
    "supplierInvoice": { "...supplier invoice + items" },
    "receiving": { "totalDocumented": "number", "totalAccepted": "number", "lineCount": "integer" }
  }
}
```

### Confirmation errors

| Status | Code | Cause |
|--------|------|-------|
| 404 | `PURCHASE_ORDER_NOT_FOUND` | PO does not exist |
| 404 | `LOCATION_NOT_FOUND` | Receiving location does not exist |
| 409 | `INACTIVE_LOCATION` | Receiving location is inactive |
| 409 | `INACTIVE_SUPPLIER` | PO supplier is inactive |
| 409 | `PURCHASE_ORDER_CANNOT_RECEIVE` | PO is `CLOSED` or `CANCELLED` |
| 409 | `DUPLICATE_INVOICE_NUMBER` | Supplier + invoice number already exists |
| 409 | `RECEIVING_DISCREPANCY_UNRESOLVED` | Documented ≠ accepted and no `discrepancyNote` |
| 422 | `UNMATCHED_INVOICE_ITEM`, `INVOICE_QUANTITY_EXCEEDS_PO_REMAINING`, `INVOICE_UNIT_MISMATCH`, `MISSING_BATCH`, `MISSING_EXPIRY` | Blocking validation failure (details carry `discrepancies[]`) |

---

## Behaviour notes

### Multiple invoices per PO
A PO may be received over many deliveries. Each confirmation compares against the
**current** remaining quantity, so `INV-001` (40), `INV-002` (30) and `INV-003`
(30) all succeed against a 100-unit order, and a 4th invoice has 0 remaining.
One PO never implies one invoice.

### Partial delivery
`PO 100`, `Invoice 60` is valid and is **not** an automatic shortage. The receipt
records 60, `quantityReceived` becomes 60, remaining becomes 40, and the PO stays
`AWAITING_DELIVERY` per the existing status logic.

### Invoice quantity vs physically received quantity
`quantity` (documented) and `acceptedQuantity` (physical) are kept separate.
`PO 100 / Invoice 100 / Delivered 90` yields: invoice still records the document,
accepted stock is 90, and 10 remains open — **not** a shortage. Only explicit
shortage acceptance (`POST /purchase-orders/items/:itemId/accept-shortage`)
reconciles that 10 permanently. A documented/physical mismatch is a
`PHYSICAL_DISCREPANCY` and requires `discrepancyNote`.

### Multiple batches per PO item
`PO 100 / Batch A 60 / Batch B 40` is one invoice line **per batch**; put both
lines in `items[]` with the same `purchaseOrderItemId` (or same SKU/name). The
aggregate accepted cap (60 + 40 ≤ 100) is enforced, and confirming creates two
stock rows / batches. (The original `@@unique([goodsReceiptId, purchaseOrderItemId])`
constraint was replaced with an index to allow this.)

### Supplier invoice number
Mapped to `SupplierInvoice.invoiceNumber` (unique per `supplierId`). No new
invoice-number field was introduced.

### Currency reconciliation
`goodsAmount` is the value of **accepted** goods at the PO unit cost (the PO cost
is authoritative — invoice price never overwrites it). The extracted `grandTotal`
is preserved by pushing any difference into `additionalChargesAmount` (positive)
or `discountAmount` (negative), so the document total is stored as printed while
`goodsAmount` still reflects only received goods.

### Concurrency
Concurrent confirmations against the same PO serialize on the `FOR UPDATE` item
lock; each re-reads the current state, so one succeeds and the other is rejected
once the remaining quantity is exhausted — no over-receiving, no partial
transaction.

### Idempotency
The canonical `goodsReceiptService.confirm` guard
(`updateMany({ where: { id, confirmedById: null } })`) prevents double-confirm.
The supplier-invoice duplicate check blocks re-posting the same invoice number.
