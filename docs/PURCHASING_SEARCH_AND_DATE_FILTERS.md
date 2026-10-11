# Purchasing — Search & Date Filters

Combined **free-text search** and **date-range filtering** for the purchasing
list endpoints:

| Endpoint | Business date field |
|----------|---------------------|
| `GET /api/v1/purchasing/purchase-orders` | `orderDate` |
| `GET /api/v1/purchasing/goods-receipts` | `receivedDate` |
| `GET /api/v1/purchasing/supplier-invoices` | `invoiceDate` |

All three endpoints accept the **same** date contract and compose it with the
filters that already exist (`supplierId`, `status`, `paymentStatus`,
`purchaseOrderId`, pagination). Every filter is applied server-side; the
`meta` counts and (where present) `summary` counts reflect the **filtered**
dataset, not just the current page.

---

## 1. Query parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `datePreset` | enum | No | `today` \| `this_week` \| `this_month` |
| `dateFrom` | date (`YYYY-MM-DD`) | No | Inclusive first calendar day (UTC) |
| `dateTo` | date (`YYYY-MM-DD`) | No | Inclusive last calendar day (UTC) |
| `search` | string ≤ 200 | No | Endpoint-specific free-text search (see §7) |

`datePreset` is **mutually exclusive** with `dateFrom`/`dateTo`.
`dateFrom` and `dateTo` may be supplied independently (open-ended).

---

## 2. Business timezone — UTC

There is no separate business-timezone configuration. The database stores
`DateTime` columns as **UTC** wall-clock values and every existing helper
(`src/utils/date-time.ts`, `src/utils/reporting/date-range.ts`, the financial
reports) reasons in **UTC calendar days**. Preset boundaries follow the same
convention:

- **today** = the current UTC calendar day;
- **this week** = the current **ISO week**, Monday `00:00:00.000Z` through the
  following Monday `00:00:00.000Z` (week starts Monday);
- **this month** = the current UTC calendar month, the 1st `00:00:00.000Z`
  through the 1st of the next month `00:00:00.000Z`.

---

## 3. Preset semantics

Presets resolve to a **closed, half-open instant range** `[gte, lt)` computed at
request time. This includes every timestamp on the final calendar day while
avoiding the classic `23:59:59.999` boundary miss.

| Preset | `gte` (inclusive) | `lt` (exclusive) |
|--------|-------------------|------------------|
| `today` | today `00:00Z` | tomorrow `00:00Z` |
| `this_week` | Monday of this week `00:00Z` | next Monday `00:00Z` |
| `this_month` | 1st of this month `00:00Z` | 1st of next month `00:00Z` |

Example: `?datePreset=this_week` returns every order whose business date falls
anywhere inside the current Monday–Sunday UTC week.

---

## 4. Custom range semantics

`dateFrom` / `dateTo` are **calendar dates** and are interpreted against the
business date field:

- `dateFrom=2026-10-01` → lower bound `2026-10-01T00:00:00.000Z` (inclusive);
- `dateTo=2026-10-05` → upper bound `2026-10-06T00:00:00.000Z` (exclusive), i.e.
  the **whole** of `2026-10-05` is included;
- either bound may be omitted: supplying only `dateFrom` leaves the range
  open-ended above, only `dateTo` leaves it open-ended below;
- supplying neither bound means **no date restriction**.

Blank values are treated as absent, so `?dateFrom=` is the same as omitting the
parameter.

---

## 5. Precedence & validation

| Input | Result |
|-------|--------|
| no date params | no date restriction |
| only `datePreset` | preset window applied |
| only `dateFrom` / only `dateTo` | open-ended custom range |
| both `dateFrom` and `dateTo` | inclusive closed range |
| `datePreset` **and** `dateFrom`/`dateTo` | **422** `VALIDATION_ERROR` |
| `dateFrom` after `dateTo` | **422** `VALIDATION_ERROR` |
| malformed date (e.g. `not-a-date`) | **422** `VALIDATION_ERROR` |

`dateFrom == dateTo` is valid and covers that single calendar day. The range
check is defense-in-depth: the service layer re-validates and throws the same
422 even if the boundary validator is bypassed.

---

## 6. Search semantics

- **Case-insensitive**, **partial** match (`contains`, Prisma
  `mode: "insensitive"`).
- Leading/trailing whitespace is trimmed; a blank or whitespace-only `search`
  behaves like no search at all (no error).
- Maximum length is 200 characters.
- When the search matches a to-many relation (order/receipt line items) the
  parent row is returned **once** — relational matching uses `some` (SQL
  `EXISTS`), so a PO with three matching line items still appears a single time
  and is counted once in `meta.total`.
- Search composes with every other filter (`AND` semantics): all supplied
  filters must match.

---

## 7. Per-endpoint search fields

### Purchase Orders — `GET /purchase-orders`

Searches across:

- `poNumber`
- `notes`
- `supplier.name`
- the name of **any medicine/product** on the order's line items
  (`items.some.product.name`)

Date filter applies to **`orderDate`**.

### Goods Receipts — `GET /goods-receipts`

Searches across:

- `receiptNumber`
- `supplier.name`
- the name of **any received medicine/product**
  (`items.some.purchaseOrderItem.product.name`)

Date filter applies to **`receivedDate`** — the date the goods were actually
received, **not** the linked purchase order's `orderDate`.

### Supplier Invoices — `GET /supplier-invoices`

The existing search is **unchanged**:

- `invoiceNumber`
- `supplier.name`

Date filter applies to **`invoiceDate`**. `invoiceNumber` remains **required**
when creating an invoice; only the list filtering changed.

---

## 8. Composition with existing filters

Search and date filters combine with the existing query parameters, e.g.:

```
GET /api/v1/purchasing/purchase-orders
    ?search=amoxicillin
    &status=AWAITING_DELIVERY
    &supplierId=<uuid>
    &datePreset=this_month
    &page=1&limit=20
```

A row must satisfy **all** supplied conditions. The response `meta.total`
(and `meta.totalPages`) as well as any `summary` block are computed over the
fully filtered dataset.

---

## 9. Pagination & counts

Pagination is unchanged (`page`, default 20 per page, `limit` max 100). Because
relational search uses `EXISTS`, `meta.total` counts each matching parent once
even when several child rows match.

---

## 10. Examples

Search a medicine name within the current month:

```
GET /api/v1/purchasing/purchase-orders?search=paracetamol&datePreset=this_month
```

Receipts entered on a specific calendar day:

```
GET /api/v1/purchasing/goods-receipts?dateFrom=2026-10-11&dateTo=2026-10-11
```

Invoices in an open-ended window (from October 1st onward):

```
GET /api/v1/purchasing/supplier-invoices?dateFrom=2026-10-01
```

Search + status + custom range:

```
GET /api/v1/purchasing/supplier-invoices
    ?search=INV-2026&status=OPEN&dateFrom=2026-09-01&dateTo=2026-09-30
```

---

## 11. Error responses

Invalid combinations return **422** with the standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "datePreset cannot be combined with dateFrom or dateTo"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "dateFrom must be on or before dateTo"
  }
}
```

---

## 12. Implementation notes

- `src/utils/date-filter.ts` — `DATE_PRESETS`, `presetRange`, `resolveDateFilter`
  (UTC, half-open `[gte, lt)`).
- `src/validators/date-filter.ts` — shared Zod fragments
  (`datePresetQuerySchema`, `dateFromQuerySchema`, `dateToQuerySchema`,
  `dateFilterQueryShape`) and cross-field `dateFilterIssues`.
- `src/validators/purchasing/{purchase-order,goods-receipt,supplier-invoice}.ts`
  — list query schemas extend the shared shape and attach `dateFilterIssues`.
- `src/services/purchasing/{purchase-order,goods-receipt,supplier-invoice}.service.ts`
  — apply the resolved range to the endpoint's business date field and build
  the `OR` search clause.
- `src/docs/openapi.ts` — shared date query parameters wired into the three list
  endpoints.

---

## 13. List-row medicine preview (`itemPreview`)

The PO and goods-receipt **list** responses add a compact medicine preview so
list rows can show *what was ordered/received* without expanding the row:

```json
"itemPreview": { "first": "Paracetamol 500mg", "additionalCount": 2 }
```

- `first` — the first **distinct** medicine/product name on the record (item
  insertion order for POs; deterministic order for receipts).
- `additionalCount` — the number of **additional distinct** products:
  `distinctProductCount − 1` (never negative). A single-product record has
  `additionalCount: 0`; a record with no resolvable product names is `null`.
- Computed with **one query per page** (never per row / no N+1), so a page of 20
  orders costs a single extra query regardless of line-item count.
- `itemPreview` is additive — it does not replace `_count.items` (PO) or
  `items` (when `includeItems=true`).
