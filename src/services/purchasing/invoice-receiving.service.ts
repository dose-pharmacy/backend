import { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { goodsReceiptService, type CreateGRInput } from "./goods-receipt.service.js";
import { supplierInvoiceService, type CreateSupplierInvoiceInput } from "./supplier-invoice.service.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";
import { toDecimal } from "../../utils/decimal.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import type { DbClient } from "./requirement.service.js";

/**
 * ============================================================================
 * Invoice-assisted receiving
 * ============================================================================
 *
 * A thin ORCHESTRATION layer on top of the canonical receiving services. The
 * uploaded supplier invoice is a *helper input*: it is matched against the
 * selected purchase order, validated against the PO's CURRENT remaining
 * quantities, and only then used to create a Goods Receipt + Supplier Invoice
 * through the SAME code paths as the manual web form
 * (`goodsReceiptService.create/confirm`, `supplierInvoiceService.create`).
 *
 * Nothing here writes stock directly. `preview()` is read-only; `confirm()` runs
 * the canonical create + confirm + invoice inside ONE transaction, so a failure
 * anywhere rolls the whole receiving operation back.
 *
 * There is no OCR/storage service in this repository yet, so the endpoint
 * accepts the ALREADY EXTRACTED, normalized invoice payload. A real OCR adapter
 * plugs in front of this service (see docs/INVOICE_RECEIVING_API.md); the
 * service never trusts extracted values and re-matches/re-validates everything
 * at confirmation time.
 */

/** Discrepancy codes surfaced to the frontend (mirrors the error codes). */
export const InvoiceDiscrepancyCode = {
  UNMATCHED_INVOICE_ITEM: "UNMATCHED_INVOICE_ITEM",
  INVOICE_QUANTITY_EXCEEDS_PO_REMAINING: "INVOICE_QUANTITY_EXCEEDS_PO_REMAINING",
  INVOICE_UNIT_MISMATCH: "INVOICE_UNIT_MISMATCH",
  MISSING_BATCH: "MISSING_BATCH",
  MISSING_EXPIRY: "MISSING_EXPIRY",
  DUPLICATE_INVOICE_NUMBER: "DUPLICATE_INVOICE_NUMBER",
  PRICE_DIFFERENCE: "PRICE_DIFFERENCE",
  PHYSICAL_DISCREPANCY: "PHYSICAL_DISCREPANCY",
} as const;
export type InvoiceDiscrepancyCode =
  (typeof InvoiceDiscrepancyCode)[keyof typeof InvoiceDiscrepancyCode];

export type InvoiceDiscrepancy = {
  code: InvoiceDiscrepancyCode;
  message: string;
  /** Blocking discrepancies prevent confirmation until corrected. */
  blocking: boolean;
  lineIndex?: number;
  purchaseOrderItemId?: string;
  details?: Record<string, unknown>;
};

export type InvoiceUploadItemInput = {
  /** User-confirmed match (overrides server-side matching when present). */
  purchaseOrderItemId?: string;
  /** SKU / product code from the invoice, if any. */
  productCode?: string;
  /** Free-text product name from the invoice. */
  productName?: string;
  /** Document / invoice quantity for the line. */
  quantity: number;
  /** Physically accepted quantity (defaults to `quantity`). */
  acceptedQuantity?: number;
  /** Unit name/symbol as printed on the invoice. */
  unit?: string;
  unitPrice?: number;
  batchNumber?: string;
  expiryDate?: Date;
  manufacturingDate?: Date;
  /** Per-line receiving location override. */
  locationId?: string;
};

export type InvoiceUploadInput = {
  /** Default receiving location for all lines. */
  locationId: string;
  receivedDate?: Date;
  invoiceNumber: string;
  invoiceDate?: Date;
  /** Supplier grand total from the invoice document (stored as-is). */
  grandTotal?: number;
  /** Informational only — the PO's supplier is authoritative. */
  supplierName?: string;
  /** Locator of the uploaded invoice document. */
  documentUrl?: string;
  /** Required when documented and accepted quantities differ. */
  discrepancyNote?: string;
  /** Payment terms for the supplier invoice. */
  paymentTerms?: "CREDIT" | "NO_CREDIT";
  /** Due date for CREDIT payment terms. */
  dueDate?: Date;
  /** Payment method for the supplier invoice. */
  paymentMethod?: "CASH" | "CARD" | "DIGITAL_TRANSFER";
  items: InvoiceUploadItemInput[];
};

const PO_ITEM_SELECT = {
  id: true,
  productId: true,
  unitId: true,
  unitCost: true,
  quantityOrdered: true,
  quantityOrderedBase: true,
  quantityReceived: true,
  quantityShort: true,
  product: {
    select: { id: true, name: true, sku: true, genericName: true, brand: true },
  },
  unit: { select: { id: true, name: true, symbol: true } },
} satisfies Prisma.PurchaseOrderItemSelect;

type POItemForMatching = Prisma.PurchaseOrderItemGetPayload<{ select: typeof PO_ITEM_SELECT }>;

type PlannedLine = {
  lineIndex: number;
  matched: boolean;
  purchaseOrderItemId: string | null;
  product: POItemForMatching["product"] | null;
  unit: POItemForMatching["unit"] | null;
  purchaseQuantity: number;
  acceptedQuantity: number;
  poOrdered: number;
  poReceived: number;
  poShort: number;
  poRemaining: number;
  remainingAfterReceipt: number;
  batchNumber: string | null;
  expiryDate: Date | null;
  manufacturingDate: Date | null;
  unitPrice: number | null;
  poUnitCost: number | null;
  locationId: string;
};

type ReceivingPlan = {
  purchaseOrder: {
    id: string;
    poNumber: string;
    status: PurchaseOrderStatus;
    supplier: { id: string; name: string };
  };
  lines: PlannedLine[];
  discrepancies: InvoiceDiscrepancy[];
  canConfirm: boolean;
  requiresDiscrepancyNote: boolean;
};

function num(value: Prisma.Decimal | number): number {
  return value instanceof Prisma.Decimal ? value.toNumber() : value;
}

function round2(value: number): number {
  return toDecimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Case/whitespace-insensitive normalization for matching extracted text. */
export function normalizeInvoiceText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function purchaseOrderItemRemaining(item: {
  quantityOrdered: Prisma.Decimal | number;
  quantityReceived: Prisma.Decimal | number;
  quantityShort: Prisma.Decimal | number;
}): number {
  return num(item.quantityOrdered) - num(item.quantityReceived) - num(item.quantityShort);
}

/**
 * Matches one invoice line to a PO item. Reliable identifiers first (explicit
 * user match, then SKU), falling back to normalized product name/generic/brand.
 * Never creates a product: an unmatched line stays unmatched.
 */
function matchLineToPOItem(
  poItems: POItemForMatching[],
  line: InvoiceUploadItemInput,
): { poItem: POItemForMatching; via: string } | null {
  if (line.purchaseOrderItemId) {
    const explicit = poItems.find((i) => i.id === line.purchaseOrderItemId);
    if (explicit) return { poItem: explicit, via: "purchaseOrderItemId" };
    return null;
  }

  const code = normalizeInvoiceText(line.productCode);
  if (code) {
    const bySku = poItems.find((i) => normalizeInvoiceText(i.product.sku) === code);
    if (bySku) return { poItem: bySku, via: "sku" };
  }

  const name = normalizeInvoiceText(line.productName);
  if (name) {
    const exact = poItems.find(
      (i) =>
        normalizeInvoiceText(i.product.name) === name ||
        normalizeInvoiceText(i.product.genericName) === name ||
        normalizeInvoiceText(i.product.brand) === name,
    );
    if (exact) return { poItem: exact, via: "name" };
  }

  return null;
}

async function assertLocation(db: DbClient, locationId: string): Promise<void> {
  const location = await db.inventoryLocation.findUnique({
    where: { id: locationId },
    select: { id: true, isActive: true },
  });
  if (!location) {
    throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Receiving location not found");
  }
  if (!location.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_LOCATION, "Receiving location is not active");
  }
}

async function loadPOForReceiving(db: DbClient, poId: string) {
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true,
      poNumber: true,
      status: true,
      supplierId: true,
      supplier: { select: { id: true, name: true, isActive: true } },
      items: { select: PO_ITEM_SELECT, orderBy: { createdAt: "asc" } },
    },
  });
  if (!po) {
    throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
  }
  if (po.status === PurchaseOrderStatus.CANCELLED || po.status === PurchaseOrderStatus.CLOSED) {
    throw new AppError(
      409,
      ErrorCode.PURCHASE_ORDER_CANNOT_RECEIVE,
      "Purchase order can no longer receive goods",
      { status: po.status },
    );
  }
  return po;
}

/**
 * Builds the receiving plan: matches lines, validates against the CURRENT PO
 * state and collects non-fatal discrepancies. Pure read logic shared by preview
 * and confirm so both always agree. Throws only for structural problems
 * (PO/location missing, order cannot receive).
 */
async function buildPlan(
  db: DbClient,
  poId: string,
  input: InvoiceUploadInput,
  supplierId: string,
): Promise<ReceivingPlan> {
  const po = await loadPOForReceiving(db, poId);
  await assertLocation(db, input.locationId);

  const discrepancies: InvoiceDiscrepancy[] = [];

  // Duplicate supplier invoice (same supplier + invoice number) — blocking.
  const duplicate = await db.supplierInvoice.findFirst({
    where: { supplierId, invoiceNumber: input.invoiceNumber },
    select: { id: true },
  });
  if (duplicate) {
    discrepancies.push({
      code: InvoiceDiscrepancyCode.DUPLICATE_INVOICE_NUMBER,
      message: "This supplier invoice has already been recorded for this supplier",
      blocking: true,
      details: { invoiceNumber: input.invoiceNumber },
    });
  }

  const lines: PlannedLine[] = [];
  // Aggregate accepted per PO item to enforce the remaining cap across batches.
  const acceptedByItem = new Map<
    string,
    { accepted: number; documented: number; poItem: POItemForMatching }
  >();

  input.items.forEach((line, index) => {
    const locationId = line.locationId ?? input.locationId;
    const acceptedQuantity = line.acceptedQuantity ?? line.quantity;
    const match = matchLineToPOItem(po.items, line);

    if (!match) {
      discrepancies.push({
        code: InvoiceDiscrepancyCode.UNMATCHED_INVOICE_ITEM,
        message: "Invoice line could not be matched to an item of the selected purchase order",
        blocking: true,
        lineIndex: index,
        details: {
          productCode: line.productCode ?? null,
          productName: line.productName ?? null,
        },
      });
      lines.push({
        lineIndex: index,
        matched: false,
        purchaseOrderItemId: null,
        product: null,
        unit: null,
        purchaseQuantity: line.quantity,
        acceptedQuantity,
        poOrdered: 0,
        poReceived: 0,
        poShort: 0,
        poRemaining: 0,
        remainingAfterReceipt: 0,
        batchNumber: line.batchNumber ?? null,
        expiryDate: line.expiryDate ?? null,
        manufacturingDate: line.manufacturingDate ?? null,
        unitPrice: line.unitPrice ?? null,
        poUnitCost: null,
        locationId,
      });
      return;
    }

    const { poItem } = match;
    const remaining = purchaseOrderItemRemaining(poItem);

    // Unit validation: never invent a conversion. Compare the printed unit
    // name/symbol against the PO item's ordered unit.
    let unitOk = true;
    if (line.unit) {
      const printed = normalizeInvoiceText(line.unit);
      const unitName = normalizeInvoiceText(poItem.unit?.name);
      const unitSymbol = normalizeInvoiceText(poItem.unit?.symbol);
      unitOk = Boolean(poItem.unit) && (printed === unitName || printed === unitSymbol);
      if (!unitOk) {
        discrepancies.push({
          code: InvoiceDiscrepancyCode.INVOICE_UNIT_MISMATCH,
          message: "Invoice line unit does not match the purchase order item unit",
          blocking: true,
          lineIndex: index,
          purchaseOrderItemId: poItem.id,
          details: {
            invoiceUnit: line.unit,
            purchaseOrderUnit: poItem.unit?.name ?? null,
            purchaseOrderUnitSymbol: poItem.unit?.symbol ?? null,
          },
        });
      }
    }

    // Batch + expiry are mandatory to receive stock (canonical rule).
    if (acceptedQuantity > 0) {
      if (!line.batchNumber) {
        discrepancies.push({
          code: InvoiceDiscrepancyCode.MISSING_BATCH,
          message: "Batch number is required to receive this line",
          blocking: true,
          lineIndex: index,
          purchaseOrderItemId: poItem.id,
        });
      }
      if (!line.expiryDate) {
        discrepancies.push({
          code: InvoiceDiscrepancyCode.MISSING_EXPIRY,
          message: "Expiry date is required to receive this line",
          blocking: true,
          lineIndex: index,
          purchaseOrderItemId: poItem.id,
        });
      }
    }

    const agg = acceptedByItem.get(poItem.id) ?? { accepted: 0, documented: 0, poItem };
    agg.accepted += acceptedQuantity;
    agg.documented += line.quantity;
    acceptedByItem.set(poItem.id, agg);

    if (line.unitPrice !== undefined && line.unitPrice !== num(poItem.unitCost)) {
      discrepancies.push({
        code: InvoiceDiscrepancyCode.PRICE_DIFFERENCE,
        message: "Invoice unit price differs from the purchase order unit cost",
        blocking: false,
        lineIndex: index,
        purchaseOrderItemId: poItem.id,
        details: { invoiceUnitPrice: line.unitPrice, poUnitCost: num(poItem.unitCost) },
      });
    }

    lines.push({
      lineIndex: index,
      matched: true,
      purchaseOrderItemId: poItem.id,
      product: poItem.product,
      unit: poItem.unit,
      purchaseQuantity: line.quantity,
      acceptedQuantity,
      poOrdered: num(poItem.quantityOrdered),
      poReceived: num(poItem.quantityReceived),
      poShort: num(poItem.quantityShort),
      poRemaining: remaining,
      remainingAfterReceipt: remaining - acceptedQuantity,
      batchNumber: line.batchNumber ?? null,
      expiryDate: line.expiryDate ?? null,
      manufacturingDate: line.manufacturingDate ?? null,
      unitPrice: line.unitPrice ?? null,
      poUnitCost: num(poItem.unitCost),
      locationId,
    });
  });

  // Aggregate cap: across ALL lines (batches) for one PO item the accepted
  // quantity must never exceed the item's current remaining quantity. This is
  // what makes multi-batch receiving safe.
  for (const [poItemId, agg] of acceptedByItem) {
    if (agg.accepted > purchaseOrderItemRemaining(agg.poItem)) {
      discrepancies.push({
        code: InvoiceDiscrepancyCode.INVOICE_QUANTITY_EXCEEDS_PO_REMAINING,
        message: "Invoice quantity exceeds the remaining quantity on the purchase order item",
        blocking: true,
        purchaseOrderItemId: poItemId,
        details: {
          remainingQuantity: purchaseOrderItemRemaining(agg.poItem),
          invoiceQuantity: agg.documented,
          acceptedQuantity: agg.accepted,
          excess: agg.accepted - purchaseOrderItemRemaining(agg.poItem),
        },
      });
    }
  }

  const requiresDiscrepancyNote = lines.some(
    (l) => l.matched && l.acceptedQuantity !== l.purchaseQuantity,
  );
  if (requiresDiscrepancyNote) {
    discrepancies.push({
      code: InvoiceDiscrepancyCode.PHYSICAL_DISCREPANCY,
      message:
        "Documented and physically accepted quantities differ; a discrepancy note is required to confirm",
      blocking: !input.discrepancyNote,
    });
  }

  return {
    purchaseOrder: {
      id: po.id,
      poNumber: po.poNumber,
      status: po.status,
      supplier: { id: po.supplier.id, name: po.supplier.name },
    },
    lines,
    discrepancies,
    canConfirm: discrepancies.every((d) => !d.blocking),
    requiresDiscrepancyNote,
  };
}

function assertPlanConfirmable(plan: ReceivingPlan, input: InvoiceUploadInput): void {
  const blocking = plan.discrepancies.filter((d) => d.blocking);
  if (blocking.length === 0) return;

  const primary = blocking[0]!;
  const statusByCode: Record<string, number> = {
    DUPLICATE_INVOICE_NUMBER: 409,
  };
  if (primary.code === InvoiceDiscrepancyCode.PHYSICAL_DISCREPANCY && !input.discrepancyNote) {
    throw new AppError(
      409,
      ErrorCode.RECEIVING_DISCREPANCY_UNRESOLVED,
      primary.message,
      { discrepancies: blocking },
    );
  }
  throw new AppError(
    statusByCode[primary.code] ?? 422,
    ((ErrorCode as Record<string, string>)[primary.code] ?? ErrorCode.VALIDATION_ERROR) as ErrorCode,
    primary.message,
    { discrepancies: blocking },
  );
}

export type InvoiceReceivingPreview = {
  purchaseOrder: ReceivingPlan["purchaseOrder"];
  receiving: {
    locationId: string;
    receivedDate: Date;
  };
  invoice: {
    invoiceNumber: string;
    invoiceDate: Date | null;
    grandTotal: number | null;
    supplierName: string | null;
    documentUrl: string | null;
  };
  items: Array<
    Omit<PlannedLine, "lineIndex"> & {
      lineIndex: number;
      /** Documented quantity = the invoice line quantity. */
      invoiceQuantity: number;
    }
  >;
  discrepancies: InvoiceDiscrepancy[];
  canConfirm: boolean;
  requiresDiscrepancyNote: boolean;
};

export type InvoiceReceivingResult = {
  purchaseOrder: {
    id: string;
    poNumber: string;
    status: PurchaseOrderStatus;
  };
  goodsReceipt: Awaited<ReturnType<typeof goodsReceiptService.confirm>>;
  supplierInvoice: Awaited<ReturnType<typeof supplierInvoiceService.create>>;
  receiving: {
    totalDocumented: number;
    totalAccepted: number;
    lineCount: number;
  };
};

export const invoiceReceivingService = {
  /** Read-only: extracts nothing, mutates nothing, writes no stock. */
  async preview(poId: string, input: InvoiceUploadInput): Promise<InvoiceReceivingPreview> {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      select: { supplierId: true },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }

    const plan = await buildPlan(prisma, poId, input, po.supplierId);

    return {
      purchaseOrder: plan.purchaseOrder,
      receiving: {
        locationId: input.locationId,
        receivedDate: input.receivedDate ?? new Date(),
      },
      invoice: {
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate ?? null,
        grandTotal: input.grandTotal ?? null,
        supplierName: input.supplierName ?? null,
        documentUrl: input.documentUrl ?? null,
      },
      items: plan.lines.map((line) => ({
        ...line,
        invoiceQuantity: line.purchaseQuantity,
      })),
      discrepancies: plan.discrepancies,
      canConfirm: plan.canConfirm,
      requiresDiscrepancyNote: plan.requiresDiscrepancyNote,
    };
  },

  /**
   * Atomically creates AND confirms a goods receipt from the uploaded invoice,
   * and creates the linked supplier invoice. The PO's items are locked first,
   * the plan is rebuilt against the locked (current) state, and the canonical
   * create/confirm/invoice code paths run inside the same transaction.
   */
  async confirm(
    poId: string,
    input: InvoiceUploadInput,
    actor: Pick<AuthenticatedUser, "id">,
  ): Promise<InvoiceReceivingResult> {
    return prisma.$transaction(
      async (tx) => {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          select: { id: true, poNumber: true, status: true, supplierId: true, supplier: { select: { isActive: true } } },
        });
        if (!po) {
          throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
        }
        if (po.status === PurchaseOrderStatus.CANCELLED || po.status === PurchaseOrderStatus.CLOSED) {
          throw new AppError(
            409,
            ErrorCode.PURCHASE_ORDER_CANNOT_RECEIVE,
            "Purchase order can no longer receive goods",
            { status: po.status },
          );
        }
        if (!po.supplier.isActive) {
          throw new AppError(409, ErrorCode.INACTIVE_SUPPLIER, "Supplier is not active");
        }

        // Serialization point: lock every PO item of this order (sorted to avoid
        // deadlocks with other receiving/invoice transactions) so the current
        // remaining quantities cannot change between validation and commit.
        await tx.$queryRaw`SELECT id FROM "purchase_order_item" WHERE "purchaseOrderId" = ${poId} ORDER BY id FOR UPDATE`;

        // Rebuild the plan against the locked, current PO state. Preview values
        // are NEVER trusted: this re-matches and re-validates from scratch.
        const plan = await buildPlan(tx, poId, input, po.supplierId);
        assertPlanConfirmable(plan, input);

        const grItems: CreateGRInput["items"] = plan.lines.map((line) => ({
          purchaseOrderItemId: line.purchaseOrderItemId!,
          locationId: line.locationId,
          // Documented quantity drives the receipt line's expectation so the
          // receipt status reflects document vs physical acceptance.
          deliveredQty: line.purchaseQuantity,
          expectedQty: line.purchaseQuantity,
          actualQty: line.acceptedQuantity,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          manufacturingDate: line.manufacturingDate,
        }));

        // Canonical creation (validates remaining cap per line, batch/expiry).
        const created = await goodsReceiptService.create(
          {
            purchaseOrderId: poId,
            receivedDate: input.receivedDate,
            discrepancyNote: input.discrepancyNote ?? null,
            items: grItems,
          },
          actor,
          tx,
        );

        // A documented/physical mismatch produces a DISCREPANCY receipt, which
        // must be resolved before it can be confirmed. The caller supplies a
        // note; otherwise confirmation is rejected.
        if (created.status === "DISCREPANCY") {
          if (!input.discrepancyNote) {
            throw new AppError(
              409,
              ErrorCode.RECEIVING_DISCREPANCY_UNRESOLVED,
              "Receiving discrepancy requires a discrepancy note before confirmation",
              { goodsReceiptId: created.id },
            );
          }
          await tx.goodsReceipt.update({
            where: { id: created.id },
            data: { status: "RESOLVED", discrepancyNote: input.discrepancyNote },
          });
        }

        // Canonical confirmation: batches + stock movements + PO quantities.
        const goodsReceipt = await goodsReceiptService.confirm(created.id, actor, tx);

        // Invoice allocation: one line per PO item (aggregated across batches),
        // using the ACCEPTED quantities — the supplier invoice records the
        // document total but only received goods are allocated.
        const acceptedByItem = new Map<string, { quantity: number; poItem: PlannedLine }>();
        for (const line of plan.lines) {
          const key = line.purchaseOrderItemId!;
          const current = acceptedByItem.get(key);
          acceptedByItem.set(key, {
            quantity: (current?.quantity ?? 0) + line.acceptedQuantity,
            poItem: line,
          });
        }

        const invoiceItems = [...acceptedByItem.entries()].map(([purchaseOrderItemId, agg]) => ({
          purchaseOrderItemId,
          quantity: agg.quantity,
          // PO unit cost is authoritative — never overwrite it from the invoice.
          unitCost: agg.poItem.poUnitCost ?? undefined,
        }));

        // Reconcile the supplier document total with the value of accepted goods
        // using the existing tax/charges/discount fields, so
        // totalAmount === extracted grandTotal while goodsAmount stays the value
        // of received goods (Phase 17: the invoice amount is NOT reduced by the
        // physical shortfall).
        const acceptedGoodsValue = round2(
          [...acceptedByItem.values()].reduce(
            (sum, agg) => sum + agg.quantity * (agg.poItem.poUnitCost ?? 0),
            0,
          ),
        );
        let additionalChargesAmount = 0;
        let discountAmount = 0;
        if (input.grandTotal !== undefined) {
          const difference = round2(input.grandTotal - acceptedGoodsValue);
          if (difference > 0) additionalChargesAmount = difference;
          else if (difference < 0) discountAmount = round2(-difference);
        }

        const invoiceInput: CreateSupplierInvoiceInput = {
          invoiceNumber: input.invoiceNumber,
          supplierId: po.supplierId,
          purchaseOrderId: poId,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate,
          additionalChargesAmount,
          discountAmount,
          paymentTerms: input.paymentTerms,
          paymentMethod: input.paymentMethod,
          documentUrl: input.documentUrl ?? null,
          items: invoiceItems,
        };

        const supplierInvoice = await supplierInvoiceService.create(invoiceInput, actor, tx);

        await recordAuditEvent(
          {
            event: AuditEvent.INVOICE_RECEIVING_CONFIRMED,
            entityId: goodsReceipt!.id,
            actorId: actor.id,
            metadata: {
              purchaseOrderId: poId,
              purchaseOrderNumber: po.poNumber,
              goodsReceiptId: goodsReceipt!.id,
              receiptNumber: goodsReceipt!.receiptNumber,
              supplierInvoiceId: supplierInvoice.id,
              invoiceNumber: supplierInvoice.invoiceNumber,
              lineCount: plan.lines.length,
              totalDocumented: plan.lines.reduce((s, l) => s + l.purchaseQuantity, 0),
              totalAccepted: plan.lines.reduce((s, l) => s + l.acceptedQuantity, 0),
            },
          },
          tx,
        );

        return {
          purchaseOrder: { id: po.id, poNumber: po.poNumber, status: goodsReceipt!.purchaseOrder.status },
          goodsReceipt,
          supplierInvoice,
          receiving: {
            totalDocumented: plan.lines.reduce((s, l) => s + l.purchaseQuantity, 0),
            totalAccepted: plan.lines.reduce((s, l) => s + l.acceptedQuantity, 0),
            lineCount: plan.lines.length,
          },
        };
      },
      // Heavier than a single receiving step (draft + confirm + invoice in one
      // transaction). Give it a larger budget for higher-latency database links.
      { timeout: 60_000, maxWait: 15_000 },
    );
  },
};
