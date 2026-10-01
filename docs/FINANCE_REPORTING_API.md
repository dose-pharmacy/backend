# Finance Reporting API — Implementation & Verification Report

A NEW, read-only financial aggregation layer over the pharmacy's existing
canonical business records. It introduces **no ledger**, **no mutation
endpoints**, **no caching**, and **does not modify** the existing finance /
dashboard endpoints. Swagger/OpenAPI is intentionally deferred to a follow-up
task.

Base path: `/api/v1/finance-reporting` (ADMIN-only, mounted in
`src/routes/v1.ts`). Existing `/api/v1/financials` routes are untouched.

---

## 1. Existing implementation audited

- **Sales** — `Sale` (`status DRAFT|COMPLETED|CANCELLED`, `subtotal`,
  `totalDiscount`, `totalAmount`, `paidAmount`, `locationId`, `createdAt`) and
  `SaleItem` (`originalUnitPrice`, `actualUnitPrice`, `discountAmount`,
  `lineTotal`, `baseQuantity`) with batch-level allocations in
  `SaleItemBatch`. A valid sale is `status = COMPLETED`; cancelled/draft sales
  are excluded. `totalAmount = subtotal − totalDiscount`, i.e. **net of the bill
  discount, and `subtotal` is already net of item-level discounts**.
- **Customer returns** — `SaleReturn` (`refundAmount`, `refundMethod`,
  `locationId`, `createdAt`) + `SaleReturnItem` / `SaleReturnItemBatch`. The
  original sale is never modified and the refund is never written into
  `SalePayment`; it lives only on the return.
- **Purchasing** — `PurchaseOrder` / `PurchaseOrderItem` (ordered/received
  quantities), `GoodsReceipt` / `GoodsReceiptItem`. No `CONFIRMED` status
  exists (only `AWAITING_DELIVERY|PARTIALLY_RECEIVED|RECEIVED|CLOSED|CANCELLED`).
- **Supplier invoices** — `SupplierInvoice`
  (`totalAmount = goodsAmount + taxAmount + additionalCharges − discount`,
  `outstandingBalance`, `status OPEN|PARTIALLY_PAID|PAID`, `invoiceDate`);
  `SupplierInvoiceItem`. Invoices carry **no location or product-group link**.
- **Supplier payments** — `SupplierPayment` (`amount`, `paymentDate`,
  `supplierInvoiceId`). **There is no payment-method column**, so a supplier
  payment breakdown by method is impossible and is deliberately not offered.
- **Supplier returns** — the hardened `PurchaseReturn`
  (`debitNoteAmount`, `appliedToPayable`, `returnedDate`, `purchaseOrderItemId`,
  `locationId`, `productId`). See §4.
- **Inventory** — `Batch` (`purchaseCost`, `expiryDate`), `InventoryStock`
  (`quantity`), `StockTransaction`, `Product`/`ProductUnit`
  (`purchasePrice` on the base unit). The codebase canonical stock value is
  `Σ inventory_stock.quantity × base-unit purchasePrice` (dashboard service).
- **Existing finance/dashboard** — `src/routes/financials.ts`,
  `src/services/financials/**`, `src/services/dashboard/dashboard.service.ts`.
  Reusable canonical helpers were reused without altering behaviour
  (`resolveReportDateRange`/`toSqlTimestamp`, `periodBucket`/`enumerateBuckets`,
  `toNumber`/`safeRatio`, `fetchOutstandingCredit`, `startOfTodayUtc`).

## 2. New endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/finance-reporting/dashboard` | Lightweight "what is happening financially right now" snapshot (today + current balances). |
| GET | `/api/v1/finance-reporting/report` | Finance Report page: period, summary, sales performance, purchasing, collections, profitability, inventory value, trends. |
| GET | `/api/v1/finance-reporting/trends` | Dedicated bucketed trend series (`DAY`\|`MONTH`\|`YEAR`). |

All three are read-only, ADMIN-guarded, and return the standard
`{ success: true, data }` envelope. Query contract: `from`, `to` (inclusive UTC
days; default last 30 days), `locationId?`, `productGroupId?`, and for the
report/trends `granularity?`.

## 3. Financial definitions

Resolved window uses the shared `resolveReportDateRange` helper: `from` →
UTC day start (inclusive), `to` → UTC end-of-day (inclusive), equivalent to a
half-open `>= from AND < dayAfter(to)` for the ms-precision `timestamp(3)`
columns. `from > to` is a 422.

| Figure | Definition |
| --- | --- |
| Gross Sales | `Σ sale.subtotal` over COMPLETED sales in the period (POS subtotal; net of item discounts, gross of the bill discount). |
| Discounts | `Σ sale.totalDiscount` (bill-level discount recorded on the sale). |
| Net Sales | `Σ sale.totalAmount` = Gross Sales − Discounts. |
| Customer Returns | `Σ sale_return.refundAmount` in the period (by `createdAt`). |
| Net Sales After Returns | Net Sales − Customer Returns. |
| COGS | `Σ sale_item_batch.baseQuantity × batch.purchaseCost`, reduced by the returned batch cost `Σ sale_return_item_batch.baseQuantity × batch.purchaseCost`. |
| Gross Profit | Net Sales After Returns − COGS. |
| Gross Margin | Gross Profit / Net Sales After Returns × 100 (0 when the denominator is 0). |
| Gross Purchases | `Σ supplier_invoice.totalAmount` where `invoiceDate` in the period. |
| Supplier Returns | `Σ purchase_return.debitNoteAmount` where `returnedDate` in the period. |
| Net Purchases | Gross Purchases − Supplier Returns. |
| Supplier Payments | `Σ supplier_payment.amount` where `paymentDate` in the period (actual cash out). |
| Supplier Outstanding | `Σ supplier_invoice.outstandingBalance` where status ∈ {OPEN, PARTIALLY_PAID} — a **current** balance, not period-limited. |
| Customer Collections | `Σ sale_payment.amount` where `createdAt` in the period, for COMPLETED sales (money actually received). |
| Customer Receivables | `Σ (sale.totalAmount − sale.paidAmount)` where COMPLETED and `paidAmount < totalAmount` — a **current** balance. |
| Inventory Value | Canonical `Σ inventory_stock.quantity × base-unit purchasePrice`; separately `batchCostValue = Σ quantity × batch.purchaseCost`, plus expiry buckets (`EXPIRED`, `0–30`, `31–90`, `91–180`, `180+` days). |

Purchases, supplier cash payments and payables are reported on separate
sources, so "Purchases 200,000 / Payments 100,000 / Outstanding 100,000" is
representable.

**Scope honesty:** sales, profitability, collections (location), and inventory
honour the requested filters. Supplier invoices/payments carry no location or
product link, so the purchasing section is reported **company-wide** for the
period; the response carries `scopeNotes` documenting this per section.

## 4. Supplier return handling

Returns are read from the hardened `PurchaseReturn` and never rewrite the
original invoice or payment.

- **Unpaid / partially-paid invoice** — the return reduces the payable; the
  `appliedToPayable` portion is surfaced as `supplierReturnAppliedToPayable`.
  Example: Invoice 100,000, Paid 60,000, Return 20,000 → the return applies to
  the open balance and the remaining payable is 20,000.
- **Fully-paid invoice** — nothing is left to apply, so `appliedToPayable = 0`
  and the whole `debitNoteAmount` is surfaced as `supplierReturnCreditEffect`
  (a supplier refund/credit). The invoice and its payment remain historical
  facts.
- Both returns still roll into `supplierReturns` / `netPurchases`, so the
  payable-reducing and refund portions are separately visible and never
  double-counted.

## 5. Performance

- All aggregation happens in PostgreSQL (CTEs / `GROUP BY` / conditional
  `SUM`); Node receives only aggregate rows.
- **No N+1**: independent sections run concurrently via `Promise.all`; the
  report runs one sales query (header + lines + COGS + returns as separate
  CTEs), one purchasing query, one collections query, one inventory query, one
  trend query, and two small breakdown queries.
- **Sale header vs sale lines are kept in separate CTEs** so a sale with several
  batch allocations is never double-counted in revenue or transaction count —
  the same pattern as the existing `fetchProductSalesAggregates`.
- **Indexes relied upon**: `sale(status,createdAt)` /
  `sale(status,locationId,createdAt)`, `sale_return(createdAt)`,
  `supplier_invoice(supplierId|status|purchaseOrderId)`,
  `batch(productId,expiryDate)`, `inventory_stock(productId|locationId)`,
  `sale_payment(saleId)`, `purchase_return(supplierId|productId|locationId)`.
- No expensive query was discovered during testing; periods with no activity
  return zeroes (never 500).
- **Caching intentionally avoided**: this is low-frequency, ADMIN-only
  reporting where stale financial figures are worse than a fresh query, and the
  module must stay an isolated read layer with no new infrastructure.

## 6. Tests

- New: `tests/finance-reporting.integration.test.ts` — **11 passed** (sales /
  discounts / returns / COGS / profitability, purchasing vs cash vs payables,
  the supplier-return applied-vs-credit split, collections & receivables,
  inventory value + expiry buckets, zero-filled daily trends, empty period →
  zeroes, reversed range → 422, dashboard snapshot, and route auth guards).
- Existing regression guards re-run: `reporting.routes.integration.test.ts`
  (10), `reporting.unit.test.ts` (29), `validation.test.ts` (4) — **43 passed**.
- `npm run typecheck` clean; ESLint clean on all new/changed files.

## 7. Confirmations

- **Existing finance endpoints unchanged** — the only edit to existing code is
  one import + one `v1Router.use("/finance-reporting", …)` line in
  `src/routes/v1.ts`. Nothing under `src/routes/financials.ts` or
  `src/services/financials/**` was touched.
- **Existing frontend contracts unchanged** — no existing route, response
  shape, or service was renamed, removed, or restructured.
- **Swagger deferred** — route definitions, validation schemas and response
  types are structured for later documentation. Endpoints/schemas needing
  OpenAPI: the three `GET /finance-reporting/*` operations, the
  `from`/`to`/`locationId`/`productGroupId`/`granularity` query parameters, and
  the `FinanceDashboard`, `FinanceReport`, and `FinanceTrends` response
  schemas.
