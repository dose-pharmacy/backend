# Supplier Catalog Lookup & Generic Audit Trail

**Base URL:** `http://localhost:4000/api/v1`
**Authentication:** Better Auth session cookie (login at `POST /api/auth/sign-in/email`)
**Content-Type:** `application/json`
**All endpoints in this document require ADMIN role** (same guard as the rest of `/purchasing`).

---

## 1. How supplier ↔ product ↔ batch is modelled

The schema has **no `Product.supplierId`** and no `ProductSupplier` join table, so the supplier
relationship is derived from the existing purchasing flow rather than duplicated:

```
Supplier
   │  PurchaseOrder.supplierId            ← supplier → product relationship
   ▼
PurchaseOrderItem.productId               ← "this product was ordered from this supplier"
   │
   │  GoodsReceipt confirmation creates the batch and stamps
   │  Batch.supplierId from the PO's supplier
   ▼
Batch (Batch.supplierId, Batch.productId) ← "this batch was received from this supplier"
   ▼
InventoryStock (locationId)
```

* **Supplier → products** = `Product.purchaseOrderItems.some(purchaseOrder.supplierId = :id)`
* **Supplier → batches** = `Batch.supplierId = :id` (plus `Batch.productId = :productId`)

`Batch.supplierId` is nullable: it is stamped by the goods-receipt confirmation. Batches created
manually (or before this field was populated) have `supplierId = NULL`. Those batches are
**excluded** from supplier lookups rather than being misattributed to a supplier, and they remain
visible in the normal batch endpoints. They also cannot be returned to a supplier through
`POST /purchase-returns`, because ownership cannot be proven.

---

## 2. `GET /purchasing/suppliers/:supplierId/products`

Products that were actually ordered from the supplier (`PurchaseOrderItem`).

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `supplierId` | string (UUID) | Yes | Supplier id |

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default 1) |
| `limit` | integer | No | Items per page (default 20, max 100) |
| `search` | string | No | Case-insensitive contains on `name`, `genericName`, `brand`, `sku` |
| `isActive` | `"true"` \| `"false"` | No | Defaults to `true` (active products only). Pass `false` to list deactivated products. |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "name": "Amoxicillin",
      "genericName": "Amoxicillin",
      "brand": "Example",
      "sku": "AMOX-500",
      "isActive": true,
      "isNarcotic": false
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

**Errors:** `404 SUPPLIER_NOT_FOUND` for an unknown supplier. Invalid UUID / `isActive` values are
rejected by request validation (`422 VALIDATION_ERROR`).

---

## 3. `GET /purchasing/suppliers/:supplierId/products/:productId/batches`

Batches of that product **traceable to that supplier**, with available stock per location.

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `supplierId` | string (UUID) | Yes | Supplier id |
| `productId` | string (UUID) | Yes | Product id |

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `locationId` | string (UUID) | No | Return only stock rows for this location |
| `inStock` | `"true"` \| `"false"` | No | Default `true`: only batches that currently have stock (at the requested location when given). `false` returns batches regardless of stock. |
| `excludeExpired` | `"true"` \| `"false"` | No | Default `true`: batches whose `expiryDate` is before today (UTC) are excluded. `false` includes expired batches. |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": "string (UUID)",
      "batchNumber": "B-2026-001",
      "productId": "string (UUID)",
      "productName": "Amoxicillin",
      "supplierId": "string (UUID)",
      "expiryDate": "ISO8601 date",
      "purchaseCost": 120.0,
      "receivedDate": "ISO8601 date|null",
      "locations": [
        {
          "locationId": "string (UUID)",
          "locationName": "Main Pharmacy",
          "availableQuantity": 25
        }
      ]
    }
  ],
  "summary": {
    "supplier": { "id": "string (UUID)", "name": "Example Supplier" },
    "product": { "id": "string (UUID)", "name": "Amoxicillin" }
  }
}
```

Notes

* `availableQuantity` follows the system-wide convention **`quantity − reservedQuantity`**
  (same figure the POS uses), and rows whose available quantity is `0` are dropped — i.e. a fully
  reserved batch is not offered for return.
* `purchaseCost` is the batch's unit cost (the existing `Batch.purchaseCost` field).
* Batches are ordered expiry-ascending, then batch number (FEFO-friendly for the return form).
* The product does not have to have been ordered from the supplier for this endpoint to answer —
  the ownership proof is `Batch.supplierId`, so a product with no batches from that supplier simply
  returns `[]`.

**Errors:** `404 SUPPLIER_NOT_FOUND`, `404 PRODUCT_NOT_FOUND`, `422 VALIDATION_ERROR` for bad query
values.

---

## 4. Purchase Return validation (hardened)

`POST /purchasing/purchase-returns` is authoritative and re-checks everything at request time — the
frontend's cached batch/quantity data is never trusted:

| Check | Failure |
|-------|---------|
| Supplier exists | `404 SUPPLIER_NOT_FOUND` |
| Supplier is active | `409 INACTIVE_SUPPLIER` |
| Product exists / is active | `404 PRODUCT_NOT_FOUND` / `409 PRODUCT_NOT_FOUND` |
| Location exists / is active | `404 LOCATION_NOT_FOUND` / `409 INACTIVE_LOCATION` |
| **Product was ordered from this supplier** (`PurchaseOrderItem`) | `422 SUPPLIER_PRODUCT_MISMATCH` |
| Batch exists | `404 BATCH_NOT_FOUND` |
| Batch belongs to the product | `422 BATCH_PRODUCT_MISMATCH` |
| **Batch was received from this supplier** (`Batch.supplierId`) | `422 SUPPLIER_BATCH_MISMATCH` |
| Quantity available at that (batch, location) | `409 PURCHASE_RETURN_INSUFFICIENT_STOCK` (`details.available`, `details.requested`) |

When `batchId` is omitted, a batch owned by the supplier with stock at the location is
auto-selected; if none exists the request fails with
`409 PURCHASE_RETURN_INSUFFICIENT_STOCK`.

Stock is validated **twice**: once before the transaction and again inside it — the stock movement
is written with `recordMovementInTransaction`, which re-checks availability under the
per-(batch, location) advisory lock. The return record, the `RETURN_TO_SUPPLIER`/`OUT`
`StockTransaction` and the audit row all commit in one transaction, and `remove()` is intentionally
immutable (`409 PURCHASE_RETURN_IMMUTABLE`).

---

## 5. Audit trail

### 5.1 Model

The project already had a generic `AuditTrail` model + read API but **nothing wrote to it**. This
feature extends and uses it — no per-domain audit tables were created.

```prisma
model AuditTrail {
  id          String       @id @default(uuid())
  userId      String?      // actor; NULL only for system/background events
  user        User?        @relation(fields: [userId], references: [id])
  action      AuditAction  // CREATE / UPDATE / DELETE / CONFIRM ...
  entity      AuditEntity  // PRODUCT / GOODS_RECEIPT / SUPPLIER_PAYMENT ...
  entityId    String
  oldData     Json?
  newData     Json?        // event metadata
  description String?      // the composite event name, e.g. GOODS_RECEIPT_CONFIRMED
  ipAddress   String?
  userAgent   String?
  createdAt   DateTime     @default(now())
}
```

The `userId` column was made **nullable** so future background/system operations can be audited
without a fake user. Business flows always populate the actor from the authenticated session.

### 5.2 Event catalogue

Central constants live in `src/services/audit/audit-events.ts` (`AuditEvent`), each paired with an
`AuditAction`/`AuditEntity`. The event name is stored in `AuditTrail.description`; `action`/`entity`
keep the existing read filters working.

| Event | Entity | Where |
|-------|--------|-------|
| `PRODUCT_CREATED` | PRODUCT | `product.service.create` (inside tx) |
| `PRODUCT_UPDATED` | PRODUCT | `product.service.update` — `isNarcotic` transitions in particular; otherwise only changed fields |
| `PRODUCT_DEACTIVATED` | PRODUCT | `product.service.update` when `isActive` flips to false |
| `PURCHASE_REQUIREMENT_CREATED` | PURCHASE_REQUIREMENT | `requirement.service.create` / generate-from-low-stock |
| `PURCHASE_REQUIREMENT_UPDATED` | PURCHASE_REQUIREMENT | `requirement.service.update` |
| `PURCHASE_REQUIREMENT_CLOSED` | PURCHASE_REQUIREMENT | `requirement.service.close` |
| `PURCHASE_ORDER_CREATED` | PURCHASE_ORDER | `purchase-order.service.create` |
| `PURCHASE_ORDER_UPDATED` | PURCHASE_ORDER | `purchase-order.service.update` |
| `PURCHASE_ORDER_CANCELLED` | PURCHASE_ORDER | `purchase-order.service.cancel` |
| `PURCHASE_ORDER_MARKED_AWAITING_DELIVERY` | PURCHASE_ORDER | `purchase-order.service.markAwaitingDelivery` |
| `PURCHASE_ORDER_CLOSED` | PURCHASE_ORDER | `purchase-order.service.close` |
| `GOODS_RECEIPT_CREATED` | GOODS_RECEIPT | `goods-receipt.service.create` |
| `GOODS_RECEIPT_RESOLVED` | GOODS_RECEIPT | `goods-receipt.service.resolve` |
| `GOODS_RECEIPT_CONFIRMED` | GOODS_RECEIPT | `goods-receipt.service.confirm` (inside tx) |
| `GOODS_RECEIPT_DELETED` | GOODS_RECEIPT | `goods-receipt.service.remove` |
| `SUPPLIER_INVOICE_CREATED` | SUPPLIER_INVOICE | `supplier-invoice.service.create` |
| `SUPPLIER_INVOICE_UPDATED` | SUPPLIER_INVOICE | `supplier-invoice.service.update` |
| `SUPPLIER_INVOICE_DELETED` | SUPPLIER_INVOICE | `supplier-invoice.service.remove` |
| `SUPPLIER_PAYMENT_RECORDED` | SUPPLIER_PAYMENT | `supplier-invoice.service.recordPayment` (inside tx) |
| `PURCHASE_RETURN_CREATED` | PURCHASE_RETURN | `purchase-return.service.create` (inside tx) |
| `SALE_COMPLETED` | SALE | POS + financials sale creation (inside tx) |
| `STOCK_ADJUSTMENT_CREATED` | STOCK_TRANSACTION | `stock.service.adjustment` (inside tx) |

No events are emitted for GET requests, and nested helpers (stock movement writes, batch updates)
are deliberately **not** audited — `StockTransaction` is already the detailed inventory ledger, so
duplicating it would only add noise.

`SALE_COMPLETED` metadata includes `locationId` and `containsNarcotic`, so a narcotic sale can be
found from the audit trail without a separate narcotic-sale table; the authoritative detail stays in
`Sale`/`SaleItem`/`Product.isNarcotic`.

### 5.3 Transaction boundaries

`recordAuditEvent(params, db)` in `src/services/audit/audit-events.ts` takes an optional Prisma
transaction client:

* **Pass `tx`** for anything that accompanies a state change (GR confirm, payment, purchase return,
  sale completion, stock adjustment, product create/update). The audit row rolls back with the
  business data, so a failed operation never leaves a "succeeded" audit record.
* **Omit `db`** to write best-effort on the shared client after the mutation has already committed
  (used only for flows with no wrapping transaction). A failure is logged, never thrown, so audit
  trouble cannot take down an already-committed business operation.

The actor is always the authenticated user id passed down from the controller (`req.user.id`) —
client-supplied `actorId`/`createdById` fields are never trusted.

### 5.4 Reading the audit trail

Existing endpoints (unchanged, ADMIN only):

```
GET /audit-trail?page=&limit=&userId=&action=&entity=&entityId=&startDate=&endDate=
GET /audit-trail/entity/:entity/:entityId
GET /audit-trail/user/:userId
```

To fetch every occurrence of one business event, filter by `entity` + the record's `entityId`
(`description` carries the composite name such as `GOODS_RECEIPT_CONFIRMED`).

---

## 6. Indexes

| Index | Why |
|-------|-----|
| `audit_trail_userId_idx` | "what did this user do" + the FK |
| `audit_trail_entity_entityId_idx` | per-record history (the common lookup) |
| `audit_trail_action_idx` | filter by action |
| `audit_trail_createdAt_idx` | time-range / newest-first listing |

These were already declared on the model and are created by the migration that first materialised
the table. No new indexes were added for the supplier lookups: `PurchaseOrder.supplierId`,
`PurchaseOrderItem.productId` and `Batch.productId` are already indexed by existing foreign keys /
model indexes, and `Batch.supplierId` is used together with an already-indexed `productId`, so the
existing plans are sufficient at this scale.

---

## 7. Migration

`prisma/migrations/20260922200000_audit_extensions` materialises the audit structure (the model
existed in `schema.prisma` but had never been created in this database) and extends the enums:

* `AuditAction` + `CONFIRM`, `CLOSE`
* `AuditEntity` + `PURCHASE_REQUIREMENT`
* `audit_trail` table with its indexes and the `userId` FK (`ON DELETE SET NULL`)

---

## 8. Frontend flow summary

```
GET /purchasing/suppliers/:supplierId/products?search=&page=&limit=
        ↓ (pick a product)
GET /purchasing/suppliers/:supplierId/products/:productId/batches?locationId=
        ↓ (pick a batch + location, read availableQuantity)
POST /purchasing/purchase-returns   { supplierId, productId, batchId, locationId, reason, quantity, unitCost }
        ↓
backend re-validates supplier/product/batch ownership + live stock,
writes the return, the RETURN_TO_SUPPLIER stock movement and PURCHASE_RETURN_CREATED audit row
in one transaction
```
