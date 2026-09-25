Yes. Before writing the implementation prompt, I think we should **freeze the business rules**. Otherwise the coding agent will make assumptions about partial deliveries, shortages, invoices, and OCR.

For your pharmacy, I would define the final design like this.

# 1. The core workflow

The customer does **one workflow**:

```text
Purchase Order
      ↓
Receive Delivery
      ↓
Upload / scan supplier invoice
      ↓
OCR extraction
      ↓
Match against selected PO
      ↓
Validate
      ↓
Show only inconsistencies
      ↓
User fixes/confirms
      ↓
Create:
   ├── Goods Receipt
   └── Supplier Invoice
      ↓
Confirm Goods Receipt
      ↓
Batch + Stock updated
```

The important thing is that the customer doesn't need to understand all these backend objects.

She sees:

> **Receive Delivery**

and the system handles the rest.

---

# 2. PO → invoice relationship

We settle this as:

### One invoice → one PO

For this MVP, an uploaded invoice must belong to the PO selected by the user.

So:

```text
PO-001
   ↑
Invoice-001
```

Not:

```text
Invoice-001
   ↓
PO-001
PO-002
PO-003
```

If the invoice contains products that aren't in the selected PO, that's an inconsistency and the user must resolve it.

---

# 3. One PO → many invoices

**Yes, absolutely support this.**

This is important.

```text
PO-001
 ├── Invoice-001 / Delivery-001
 ├── Invoice-002 / Delivery-002
 └── Invoice-003 / Delivery-003
```

The PO's received quantity must therefore be cumulative.

Example:

### PO

```text
Amoxicillin = 100
```

### First invoice

```text
Invoice #1
Amoxicillin = 40
```

After receiving:

```text
Ordered:   100
Received:   40
Remaining:  60
```

### Second invoice

```text
Invoice #2
Amoxicillin = 60
```

The system must compare against:

```text
CURRENT REMAINING = 60
```

not the original `100`.

After receiving:

```text
Ordered:   100
Received:  100
Remaining:   0
```

This is already aligned with your:

```ts
quantityOrdered
- quantityReceived
- quantityShort
```

logic.

---

# 4. Very important: invoice quantity ≠ accepted stock quantity

We should preserve your three concepts:

```text
expectedQty
deliveredQty
actualQty
```

### Example

PO expects:

```text
100
```

Supplier invoice says:

```text
100
```

but physically only 98 arrived.

Then:

```text
expectedQty = 100
deliveredQty = 98
actualQty = 98
```

That's a **discrepancy**.

Another example:

```text
Supplier says/delivers 100
```

but 3 are damaged:

```text
deliveredQty = 100
actualQty = 97
```

That's also a discrepancy.

This distinction is valuable because:

> **The invoice tells us what the supplier billed/delivered according to the document. The physical receiving process determines what the pharmacy actually accepts into stock.**

---

# 5. Partial delivery is NOT automatically a shortage

This distinction is important.

Suppose:

```text
PO = 100
Invoice/delivery = 60
```

That does **not necessarily mean 40 are short**.

It could simply mean:

> Supplier delivered 60 now and will deliver 40 later.

So:

```text
Received = 60
Remaining = 40
PO = AWAITING_DELIVERY
```

Then another invoice can come later.

---

# 6. What is a real shortage?

A shortage happens when the remaining quantity is **accepted as no longer expected to arrive**.

Example:

```text
PO = 100
Received = 60
Remaining = 40
```

Supplier says:

> We cannot supply the remaining 40.

User chooses:

> **Accept shortage: 40**

Then:

```text
quantityReceived = 60
quantityShort = 40
```

and:

```text
remaining expectation =
100 - 60 - 40
= 0
```

That is different from simply receiving 60.

---

# 7. How shortage should interact with a scanned invoice

Suppose:

```text
PO = 100
```

Invoice says:

```text
60
```

The scan should **not automatically create a shortage**.

It should say:

> 40 units remain on the PO.

Then the user can either:

### Continue waiting

```text
Receive 60
Remaining 40
```

or later:

### Accept shortage

```text
Shortage = 40
```

This is much safer.

---

# 8. What if invoice says MORE than the PO remaining?

Example:

```text
PO remaining = 40
Invoice = 50
```

This should be an exception.

Do not automatically receive 50.

Show:

> **Invoice quantity exceeds the remaining PO quantity by 10.**

Then the user needs to resolve it.

For your current system, I would keep the backend rule strict:

```text
actualQty <= expectedQty
```

as you already have.

---

# 9. What if invoice says LESS than remaining?

Example:

```text
PO remaining = 100
Invoice = 60
```

This is allowed.

It means:

```text
partial delivery
```

not necessarily shortage.

The resulting PO remains open/awaiting delivery.

---

# 10. What if invoice says 100 but only 90 physically arrived?

Then:

```text
Invoice quantity = 100
deliveredQty = 90
actualQty = 90
```

This is a discrepancy.

The user should be able to see:

```text
Invoice/document: 100
Physically delivered: 90
Accepted into stock: 90
Difference: 10
```

Then there are two possibilities:

### Temporary discrepancy

Supplier will send the missing 10 later.

PO remains open.

### Accepted shortage

Supplier confirms the 10 will never arrive.

User resolves the shortage.

```text
quantityShort += 10
```

---

# 11. What if delivered quantity is 100 but only 95 is acceptable?

Then:

```text
deliveredQty = 100
actualQty = 95
```

The difference is:

```text
5
```

Those 5 should **not enter inventory**.

Your current GR model already supports this nicely.

The backend confirmation should create stock only for:

```text
actualQty
```

not `deliveredQty`.

---

# 12. Batch handling

The invoice scan can extract:

```text
batchNumber
expiryDate
manufacturingDate
```

Those should populate the Goods Receipt.

For example:

```text
Product: Amoxicillin
Batch: AMX-001
Expiry: 2028-10-20
Delivered: 50
Accepted: 48
```

When the GR is confirmed:

```text
Batch AMX-001
Stock +48
```

Not +50.

---

# 13. Multiple batches for one PO item

We should also account for this.

Suppose PO says:

```text
Amoxicillin = 100
```

Supplier invoice says:

```text
Amoxicillin = 100
```

but physically the supplier gives:

```text
Batch A = 60
Batch B = 40
```

The receiving system should eventually support:

```text
PO Item
   ├── GR Item / Batch A = 60
   └── GR Item / Batch B = 40
```

Your current `GoodsReceiptItem` appears to have one `batchNumber` per item, so **this is something we need to inspect before implementation**.

For the MVP, if the supplier's invoice normally has one batch per product line, you don't need to overcomplicate it.

But I would explicitly tell the agent:

> Inspect whether the current schema can represent multiple batches for one PO item within one receipt. Do not silently assume one product = one batch forever.

If the schema already supports multiple GR items for the same PO item, we're fine.

---

# 14. Supplier Invoice creation

I agree with your simplification:

> **`invoiceAmount = grand total`**

No detailed accounting system now.

The OCR extracts:

```text
Invoice number
Invoice date
Grand total
Supplier
```

and creates:

```text
SupplierInvoice
status = OPEN
invoiceAmount = grandTotal
```

The existing payment workflow remains:

```text
OPEN
 ↓
payment
 ↓
PARTIALLY_PAID
 ↓
payment
 ↓
PAID
```

---

# 15. Invoice should NOT automatically mean "paid"

Absolutely keep:

```text
Invoice created ≠ Payment made
```

Scanning the supplier invoice only creates the obligation.

The customer separately records payment.

---

# 16. Invoice discrepancy vs delivery discrepancy

This is another distinction worth locking down.

### Delivery discrepancy

Examples:

```text
Expected 100
Delivered 90
```

or:

```text
Delivered 100
Accepted 95
```

This belongs to **Goods Receipt**.

### Invoice discrepancy

Examples:

```text
PO unit cost = 100
Invoice unit price = 110
```

or:

```text
PO expected amount differs from invoice
```

This belongs to the **Supplier Invoice review**.

Since your Supplier Invoice currently only stores the grand total, we don't need a complicated invoice-line reconciliation system.

Just show the user the difference before confirmation.

---

# 17. Should invoice creation be blocked by delivery discrepancy?

I would say **no**.

This is important.

Suppose the invoice says:

```text
100 units
Grand total = 10,000
```

but only:

```text
90 units
```

arrived.

The pharmacy still has the supplier's invoice.

So you can have:

```text
Goods Receipt:
DISCREPANCY

Supplier Invoice:
OPEN
10,000
```

These are separate business facts.

The user can resolve the physical discrepancy without losing the financial document.

---

# 18. But don't create stock before confirmation

This remains a hard rule.

### Scan:

```text
NO STOCK CHANGE
```

### OCR validation:

```text
NO STOCK CHANGE
```

### Create draft:

```text
NO STOCK CHANGE
```

### User confirms:

```text
Goods Receipt confirmation
        ↓
Batch
        ↓
Stock Movement
        ↓
Inventory
```

This protects you from bad OCR.

---

# 19. What should happen if OCR can't read something?

Don't guess.

For example:

```text
Batch number: ????
```

The UI should say:

> Batch number could not be reliably detected. Please enter it.

Same for:

* expiry
* quantity
* product code
* invoice number
* grand total

The backend should allow the user-provided corrected value through the final confirmation flow.

---

# 20. Product matching

Because the user first selects the PO, we don't need complicated global product matching.

Use the PO as the candidate set.

Conceptually:

```text
Selected PO
   ↓
PO items
   ↓
OCR invoice lines
   ↓
Match by product code / known product identity
```

If an invoice line can't be matched:

> Product not found in selected purchase order.

Don't automatically create a new product.

---

# 21. Unit matching

Same principle.

PO says:

```text
BOX
```

Invoice says:

```text
BOX
```

✓

PO says:

```text
BOX
```

Invoice says:

```text
BOTTLE
```

⚠

Don't silently convert.

If conversion is already explicitly configured and appropriate, the system can later support it, but **don't make OCR invent conversions.**

---

# 22. Location

The invoice doesn't reliably tell us the pharmacy's internal stock location.

Therefore:

```text
Receiving Location
```

must come from:

1. PO/default receiving location if available, otherwise
2. user selection.

Don't ask OCR to determine it.

---

# 23. Multi-invoice workflow

The PO detail should basically show:

```text
PO-001

Ordered:    100
Received:    60
Short:        0
Remaining:   40

Deliveries:
--------------------------------
GR-001
Invoice INV-001
Received 60
Confirmed ✓

[ Receive Delivery ]
```

Next time:

```text
[ Receive Delivery ]
```

System calculates the current remaining quantities again.

This is crucial.

**Never rely on what was extracted during the first scan.**

Every new receiving attempt loads the latest PO state from the database.

---

# 24. What if the second invoice comes after a shortage was accepted?

Example:

```text
PO = 100
Received = 60
Shortage accepted = 40
```

Remaining expected:

```text
0
```

Then supplier somehow sends another invoice/delivery for 10.

The backend should reject it because the PO has already been reconciled.

The user would need a new PO or whatever business process you eventually choose.

Don't silently reopen the old PO.

---

# 25. What if invoice is duplicated?

This is important with scanning.

Suppose the customer accidentally scans:

```text
INV-001
```

twice.

The backend should not create:

```text
Invoice-001
Invoice-001-copy
```

Supplier invoice number should remain unique per supplier, as your existing design already says.

So:

```text
supplierId + invoiceNumber
```

should prevent duplicate invoices.

The UI should say something like:

> This supplier invoice has already been recorded.

This is a very useful protection for a one-person pharmacy.

---

# 26. What if the same PO has multiple invoices?

No problem:

```text
PO-001
 ├── INV-001
 ├── INV-002
 └── INV-003
```

As long as:

```text
supplierId + invoiceNumber
```

is unique.

And each receiving operation compares against the **current remaining PO quantities**.

---

# 27. The final state model

I'd think about it like this:

### PO

```text
REGISTERED
    ↓
AWAITING_DELIVERY
    ↓
RECEIVED
    ↓
CLOSED
```

### Goods Receipt

```text
Created
   ↓
MATCHED
or
DISCREPANCY
   ↓
RESOLVED
   ↓
CONFIRMED
```

Your existing statuses can stay largely intact.

### Supplier Invoice

```text
OPEN
 ↓
PARTIALLY_PAID
 ↓
PAID
```

And these three workflows remain connected through the PO.

---

# 28. The complete example

Let's run the whole thing.

### PO

```text
Amoxicillin     100
Cefixime         50
```

### First invoice

```text
Amoxicillin      60
Cefixime         30
Grand total      15,000
```

Scan → validation:

```text
✓ Supplier
✓ Products
✓ Units
✓ Quantities
✓ Invoice number
✓ Grand total
```

Create:

```text
GR-001
Invoice-001
```

Inventory:

```text
Amoxicillin +60
Cefixime +30
```

PO:

```text
Received:
Amoxicillin 60
Cefixime 30

Remaining:
Amoxicillin 40
Cefixime 20
```

---

### Second invoice

```text
Amoxicillin 40
Cefixime    15
Grand total 10,000
```

Scan.

System compares against:

```text
Amoxicillin remaining = 40 ✓
Cefixime remaining = 20
Invoice = 15 ✓ partial
```

Create:

```text
GR-002
Invoice-002
```

Now:

```text
Amoxicillin remaining = 0
Cefixime remaining = 5
```

PO remains open.

---

### Supplier says remaining Cefixime 5 won't be delivered

User:

> Accept shortage = 5

Now:

```text
Ordered: 50
Received: 45
Short: 5
Remaining: 0
```

PO can move to its completed/received/closed state according to your existing rules.

---

# 29. So I would lock these rules before coding

### ✅ We are doing

* User selects **one PO first**.
* One scanned invoice belongs to **one PO**.
* One PO can have **many invoices**.
* One PO can have **many Goods Receipts**.
* Each receiving attempt uses the PO's **current remaining quantities**.
* OCR extracts invoice data.
* PO provides the authoritative expected products/units/quantities.
* OCR data is validated against the PO.
* Partial delivery is allowed.
* Shortage is **not automatically assumed** from partial delivery.
* Shortage is explicitly accepted/reconciled.
* `deliveredQty` and `actualQty` remain separate.
* Batch/expiry/manufacturing data comes from the delivery document.
* Inventory changes only when GR is confirmed.
* `invoiceAmount = grand total`.
* Supplier Invoice is created as `OPEN`.
* Payment remains separate.
* Invoice discrepancies don't automatically destroy/block the physical receiving record.
* Duplicate supplier invoices are rejected.
* Location comes from PO/default/user selection, not OCR.
* OCR failures require user correction rather than guessing.

### ❌ We are NOT doing now

* Multi-PO invoices.
* Detailed invoice accounting/tax line system.
* Automatic payment.
* Prescription/accounting complexity.
* General-purpose invoice recognition for arbitrary formats.
* Automatically creating stock directly from OCR.
* Automatically converting mismatched units.
* Automatically accepting shortages.
* Automatically changing PO costs because invoice prices differ.
* Complex invoice-to-GR reconciliation accounting.

---

## One final architectural point I'd add

I would make the new backend feature conceptually an **"invoice-assisted receiving"** workflow, rather than an "invoice upload" feature.

Because the real operation is:

> **Use the supplier invoice to speed up Goods Receipt creation.**

The invoice is the input that makes receiving faster. It shouldn't become the authority over your inventory.

So the backend flow becomes:

```text
                    SELECTED PO
                        │
                        ▼
                 Upload Invoice
                        │
                        ▼
                    OCR Scan
                        │
                        ▼
               Extract invoice data
                        │
                        ▼
              Match against PO items
                        │
                        ▼
             Validate current remaining
                        │
            ┌───────────┴───────────┐
            │                       │
        No issues              Issues found
            │                       │
            │                 User corrects
            │                       │
            └───────────┬───────────┘
                        ▼
                 Confirm receiving
                    /          \
                   /            \
                  ▼              ▼
          Goods Receipt      Supplier Invoice
                  │                │
                  ▼                ▼
             Batch/Stock          OPEN
```

**I think this is the right final scope.** It gives your customer the big speed improvement she actually needs while keeping your existing PO → GR → Batch → Inventory and PO → Invoice → Payment architecture intact.
