# Narcotic / Controlled Product Support (MVP)

**Status:** Implemented — boolean flag + report. No RBAC, no prescription data, no separate tables (by design, per MVP scope).

**Auth:** Better Auth session cookie (`POST /api/auth/sign-in/email`). All endpoints below require **ADMIN** (same guard as the rest of inventory/financials).

---

## 1. The flag

`Product.isNarcotic` — plain boolean, default `false`. Existing products are unaffected.
The frontend must **never** infer narcotic status from names/groups; always read `isNarcotic`.

## 2. Product API

### `POST /api/v1/inventory/products`
`isNarcotic` is an **optional boolean** (default `false`) in the body:

```json
{
  "name": "Morphine 10mg",
  "sku": "MOR-001",
  "productGroupId": "<uuid>",
  "isNarcotic": true
}
```

Sending `"yes"`, `1`, etc. → 422 (strict boolean validation).
Omitting it → product is created as non-narcotic (backward compatible).

### `PATCH /api/v1/inventory/products/:id`
Optional boolean. Toggle in either direction:

```json
{ "isNarcotic": true }
```

### Responses that expose `isNarcotic`
- `GET /api/v1/inventory/products` (list) — every item
- `GET /api/v1/inventory/products/:id` (detail) — plus all nested data
- create / update responses — the full product row
- `GET /api/v1/pos/products` — see below

## 3. POS

### `GET /api/v1/pos/products`
Every item now carries the flag:

```json
{
  "id": "...",
  "name": "Example Medicine",
  "sku": "MED-001",
  "brand": "Example",
  "isNarcotic": true,
  "availableStock": 12,
  "stockStatus": "IN_STOCK"
}
```

**Frontend duty:** when any cart line's product has `isNarcotic: true`, show the reminder
*Narcotic medicine — check the required prescription/reference before completing the sale*
before `POST /api/v1/pos/sales`.

### `POST /api/v1/pos/sales` and `GET /api/v1/pos/sales/:id`
- No prescription field is required or accepted — nothing changed in the request shape.
- Sale detail items include `product.isNarcotic`, so the badge can be shown on receipts/history.

> **Note:** narcotic sales are NOT restricted yet. RBAC lands later; the sale service
> already loads `isNarcotic` per line, with a TODO marking the enforcement point.

## 4. Narcotic report

### `GET /api/v1/financials/reports/narcotics`
Paginated narcotic product summary. **Response envelope** = standard
`{ success, data, meta: { page, limit, total, totalPages } }`.

**Query parameters** (all optional):

| Param | Type | Notes |
|---|---|---|
| `page` | int ≥ 1 | default 1 |
| `limit` | int 1–100 | default 20 |
| `search` | string ≤ 200 | matches name / generic name / brand / SKU (case-insensitive) |
| `productId` | UUID | exact product |
| `locationId` | UUID | narrows current-stock batch rows |
| `dateFrom` | date | inclusive, UTC day start |
| `dateTo` | date | **inclusive through end of that UTC day** |

**Each data item:**

```json
{
  "productId": "...",
  "productName": "Morphine",
  "sku": "MOR-001",
  "genericName": "Morphine sulfate",
  "brand": "Example",
  "isNarcotic": true,
  "batches": [
    {
      "batchId": "...",
      "batchNumber": "B-001",
      "expiryDate": "2028-01-01T00:00:00.000Z",
      "locationId": "...",
      "locationName": "Main Pharmacy",
      "currentQuantity": 12
    }
  ],
  "soldQuantity": 5,
  "purchasedQuantity": 20,
  "adjustedQuantity": -1
}
```

Semantics:
- `currentQuantity` comes from the **authoritative `InventoryStock`** rows
  (`quantity - reservedQuantity`) — NOT `purchases - sales`. It already reflects
  adjustments, returns, expiry actions and transfers.
- `soldQuantity` — completed sales only (`SaleItem.baseQuantity`), never cancelled sales.
- `purchasedQuantity` — `PURCHASE` + `OPENING` movements in the window.
- `adjustedQuantity` — net signed impact of `ADJUSTMENT_IN` − `ADJUSTMENT_OUT`
  (e.g. −1 means one unit adjusted out).
- A metric with **no activity in the window is omitted**, not zero.
- Products with no stock still appear (with empty `batches`).
- Filtering happens **in PostgreSQL** (`Product.isNarcotic = true` + filters + pagination).

### `GET /api/v1/financials/reports/narcotics/activity`
Movement-level traceability for narcotic products, from the immutable
`StockTransaction` ledger.

**Extra query parameters:** `batchId` (UUID), `movementType` (one of the existing
`StockTransactionType` values: `PURCHASE`, `SALE`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`,
`RETURN_IN`, `RETURN_TO_SUPPLIER`, `EXPIRY`, `DISPOSAL`, `OPENING`, `TRANSFER_IN`,
`TRANSFER_OUT`, `CORRECTION`, `CLEARANCE_SALE`). No new movement types exist — a
narcotic sale is still `SALE`.

**Each data item:**

```json
{
  "transactionId": "...",
  "date": "2026-09-21T10:00:00.000Z",
  "productId": "...",
  "productName": "Morphine",
  "sku": "MOR-001",
  "batchId": "...",
  "batchNumber": "B-001",
  "expiryDate": "2028-01-01T00:00:00.000Z",
  "locationId": "...",
  "locationName": "Main Pharmacy",
  "movementType": "SALE",
  "direction": "OUT",
  "quantity": 2,
  "balanceAfter": 12,
  "reference": "Sale:<saleId>"
}
```

## 5. Errors

Standard error envelope. 422 for invalid UUIDs/dates/pagination/`movementType`,
401/403 for auth, 404 for nonexistent `productId`. `dateFrom > dateTo` → 422.

## 6. What is deliberately NOT included (future work)

- Role restriction of narcotic sales (RBAC pending — enforcement point marked in `sale.service.ts`)
- Prescription uploads, doctor/patient records, authorization numbers
- Separate narcotic inventory/ledger tables
- Product-class enum (`NORMAL` / `CONTROLLED` / …) — extend from the boolean when needed
