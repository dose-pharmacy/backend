import { Prisma, PurchaseOrderStatus, PurchaseRequirementStatus } from "@prisma/client";

/** Derived (never persisted) payment status of a purchase order. */
export const PurchaseOrderPaymentStatus = {
  NOT_INVOICED: "NOT_INVOICED",
  UNPAID: "UNPAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
} as const;
export type PurchaseOrderPaymentStatus =
  (typeof PurchaseOrderPaymentStatus)[keyof typeof PurchaseOrderPaymentStatus];
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { recomputeRequirementStatus } from "./requirement.service.js";
import { productUnitService } from "../inventory/product-unit.service.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";
import type { DbClient } from "./requirement.service.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreatePOItemInput = {
  productId: string;
  quantityOrdered: number;
  /** Unit the quantity is expressed in; defaults to the product's base unit. */
  unitId?: string | null;
  unitCost: number;
  requirementLineId?: string | null;
};

export type CreatePOInput = {
  supplierId: string;
  expectedDeliveryDate?: Date | null;
  notes?: string | null;
  items: CreatePOItemInput[];
};

export type CreatePOFromRequirementItemInput = {
  requirementLineId: string;
  quantityOrdered: number;
  unitCost: number;
};

export type CreatePOFromRequirementInput = {
  supplierId: string;
  expectedDeliveryDate?: Date | null;
  notes?: string | null;
  items: CreatePOFromRequirementItemInput[];
};

export type UpdatePOInput = Partial<{
  expectedDeliveryDate: Date | null;
  notes: string | null;
}>;

export type UpdatePOItemInput = Partial<{
  quantityOrdered: number;
  unitCost: number;
}>;

export type POListQuery = PageQuery & {
  supplierId?: string;
  status?: PurchaseOrderStatus;
  paymentStatus?: PurchaseOrderPaymentStatus | "ALL";
  search?: string;
};

export type PopaymentSummary = {
  status: PurchaseOrderPaymentStatus;
  invoiceCount: number;
  invoicedAmount: number;
  paidAmount: number;
  outstandingAmount: number;
};

export type POReceivingSummary = {
  orderedQuantity: number;
  receivedQuantity: number;
  shortQuantity: number;
  remainingQuantity: number;
};

/**
 * Three different financial concepts, deliberately kept separate:
 *  - orderedGoodsValue: commercial value of the PO (SUM(quantityOrdered x unitCost))
 *  - receivedGoodsValue: value of goods actually received (never shortages)
 *  - goodsInvoicedAmount: value of received goods billed on invoices
 *  - remainingGoodsToInvoice: receivedGoodsValue - goodsInvoicedAmount
 */
export type POGoodsSummary = {
  orderedGoodsValue: number;
  receivedGoodsValue: number;
  goodsInvoicedAmount: number;
  remainingGoodsToInvoice: number;
};

function roundMoney(value: Prisma.Decimal | number): number {
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return decimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * Derives the payment status of a PO from its invoice aggregates. Never stored:
 * it is always computed from invoice/payment records so it can never go stale.
 */
export function derivePaymentStatus(row: {
  invoiceCount: number;
  invoicedAmount: Prisma.Decimal | number;
  outstandingAmount: Prisma.Decimal | number;
}): PurchaseOrderPaymentStatus {
  if (row.invoiceCount === 0) return PurchaseOrderPaymentStatus.NOT_INVOICED;
  const outstanding = row.outstandingAmount instanceof Prisma.Decimal
    ? row.outstandingAmount
    : new Prisma.Decimal(row.outstandingAmount);
  const invoiced = row.invoicedAmount instanceof Prisma.Decimal
    ? row.invoicedAmount
    : new Prisma.Decimal(row.invoicedAmount);
  if (outstanding.lte(0)) return PurchaseOrderPaymentStatus.PAID;
  const paid = invoiced.minus(outstanding);
  if (paid.lte(0)) return PurchaseOrderPaymentStatus.UNPAID;
  return PurchaseOrderPaymentStatus.PARTIALLY_PAID;
}

/**
 * Aggregates invoice money per PO directly in the database (one row per PO that
 * has invoices) and derives the payment status from the sums. `paid` is derived
 * as invoiced - outstanding so partially paid invoices always reconcile.
 */
async function paymentAggregatesByPo(): Promise<Map<string, PopaymentSummary>> {
  const rows = await prisma.supplierInvoice.groupBy({
    by: ["purchaseOrderId"],
    where: { purchaseOrderId: { not: null } },
    _sum: { totalAmount: true, outstandingBalance: true },
    _count: { _all: true },
  });

  const map = new Map<string, PopaymentSummary>();
  for (const row of rows) {
    const poId = row.purchaseOrderId as string;
    const invoiced = row._sum.totalAmount ?? new Prisma.Decimal(0);
    const outstanding = row._sum.outstandingBalance ?? new Prisma.Decimal(0);
    const paid = invoiced.minus(outstanding);
    map.set(poId, {
      status: derivePaymentStatus({
        invoiceCount: row._count._all,
        invoicedAmount: invoiced,
        outstandingAmount: outstanding,
      }),
      invoiceCount: row._count._all,
      invoicedAmount: roundMoney(invoiced),
      paidAmount: roundMoney(paid),
      outstandingAmount: roundMoney(outstanding),
    });
  }
  return map;
}

/** Attaches (or defaults) the payment summary on a list of POs. */
async function attachPaymentSummaries<
  T extends { id: string; paymentSummary?: unknown },
>(pos: T[]): Promise<T[]> {
  const needsSummary = pos.some((po) => po.paymentSummary === undefined);
  const aggregates = needsSummary ? await paymentAggregatesByPo() : null;
  return pos.map((po) => {
    if (po.paymentSummary !== undefined) return po;
    const summary = aggregates!.get(po.id);
    return {
      ...po,
      paymentSummary:
        summary ??
        ({
          status: PurchaseOrderPaymentStatus.NOT_INVOICED,
          invoiceCount: 0,
          invoicedAmount: 0,
          paidAmount: 0,
          outstandingAmount: 0,
        } satisfies PopaymentSummary),
    };
  });
}

export function buildReceivingSummary(items: Array<{
  quantityOrdered: Prisma.Decimal | number;
  quantityReceived: Prisma.Decimal | number;
  quantityShort: Prisma.Decimal | number;
}>): POReceivingSummary {
  const num = (v: Prisma.Decimal | number) =>
    (v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v)).toNumber();
  const ordered = items.reduce((s, i) => s + num(i.quantityOrdered), 0);
  const received = items.reduce((s, i) => s + num(i.quantityReceived), 0);
  const short = items.reduce((s, i) => s + num(i.quantityShort), 0);
  return {
    orderedQuantity: ordered,
    receivedQuantity: received,
    shortQuantity: short,
    remainingQuantity: Math.max(0, ordered - received - short),
  };
}

/**
 * A PO item is fully accounted for when received + accepted short covers the
 * ordered quantity. Accepted shortages are valid completion.
 */
export function isItemFullyAccountedFor(item: {
  quantityOrdered: Prisma.Decimal;
  quantityReceived: Prisma.Decimal;
  quantityShort: Prisma.Decimal;
}): boolean {
  return item.quantityReceived.plus(item.quantityShort).gte(item.quantityOrdered);
}

/** Internal shape where a requirement-linked item may omit (and derive) its product. */
type ResolvedItemInput = {
  productId?: string;
  quantityOrdered: number;
  unitId?: string | null;
  unitCost: number;
  requirementLineId?: string | null;
};

type ResolvedCreateInput = Omit<CreatePOInput, "items"> & { items: ResolvedItemInput[] };

// Requirement-aware order creation performs several dependent queries (lock, aggregate,
// create, recompute) inside one transaction. Allow a generous budget so it does not time
// out under load or on higher-latency database connections.
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const;

const PO_DETAIL_INCLUDE = {
  supplier: { select: { id: true, name: true, contactPerson: true, email: true, phone: true } },
  createdBy: { select: { id: true, name: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      unit: { select: { id: true, name: true, symbol: true } },
      requirementLine: {
        select: {
          id: true,
          quantityNeeded: true,
          quantityDelivered: true,
          status: true,
          requirement: { select: { id: true, reference: true, status: true } },
        },
      },
      allocations: {
        select: { id: true, requirementLineId: true, quantityAllocated: true },
      },
    },
  },
  goodsReceipts: {
    select: { id: true, receiptNumber: true, status: true, receivedDate: true },
    orderBy: { createdAt: "desc" as const },
  },
  supplierInvoices: {
    select: { id: true, invoiceNumber: true, goodsAmount: true, totalAmount: true, outstandingBalance: true, status: true },
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.PurchaseOrderInclude;

function generatePONumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `PO-${timestamp}${random}`;
}

async function assertSupplierActive(supplierId: string, db: DbClient = prisma): Promise<void> {
  const supplier = await db.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true, isActive: true },
  });
  if (!supplier) {
    throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
  }
  if (!supplier.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_SUPPLIER, "Supplier is not active");
  }
}

async function assertProductActive(productId: string, db: DbClient = prisma): Promise<void> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, isActive: true },
  });
  if (!product) {
    throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
  }
  if (!product.isActive) {
    throw new AppError(409, ErrorCode.PRODUCT_NOT_FOUND, "Product is not active");
  }
}

/**
 * Takes a row-level lock on the requirement lines involved in a transaction. This is
 * the serialization point that guarantees
 * `SUM(active allocations) <= requiredQuantity` under concurrent order creation.
 * Lines are locked in sorted order to avoid deadlocks between concurrent requests.
 */
/** The product's base unit id (cached per call site via caller transactions). */
async function baseUnitIdFor(db: Prisma.TransactionClient, productId: string): Promise<string> {
  const base = await db.productUnit.findFirst({
    where: { productId, isBaseUnit: true },
    select: { unitId: true },
  });
  if (!base) {
    throw new AppError(
      422,
      ErrorCode.BASE_UNIT_REQUIRED,
      "The product has no base unit configured; configure product units first",
    );
  }
  return base.unitId;
}

async function lockRequirementLines(
  tx: Prisma.TransactionClient,
  lineIds: Array<string | null | undefined>,
): Promise<string[]> {
  const unique = [...new Set(lineIds.filter((id): id is string => Boolean(id)))].sort();
  if (unique.length === 0) {
    return unique;
  }
  await tx.$queryRaw`SELECT id FROM "purchase_requirement_line" WHERE id IN (${Prisma.join(unique)}) FOR UPDATE`;
  return unique;
}

/**
 * Computes the effective allocated quantity for a requirement line, accounting for
 * accepted shortages. Shortages reduce the effective allocation because they represent
 * units that will NOT be delivered and therefore free up capacity for other suppliers.
 */
async function sumActiveAllocations(tx: Prisma.TransactionClient, lineId: string): Promise<number> {
  // For each allocation, effective = quantityAllocated - (quantityOrdered - quantityReceived - quantityShort)
  // = quantityReceived + quantityShort (the "committed to receive" amount)
  // But simpler: we should count only the net commitment = received + expected remaining
  // Actually the right formula: effective allocation = quantityReceived + MIN(ordered - received, ordered - received - short)
  // = quantityReceived + remaining_to_receive
  // where remaining_to_receive = max(0, ordered - received - short)
  //
  // For simplicity: effective = quantityReceived + max(0, quantityOrdered - quantityReceived - quantityShort)
  // This means: if short is accepted, we don't count those units as still-needed
  const rows = await tx.$queryRaw<
    Array<{
      quantityAllocated: Prisma.Decimal;
      quantityReceived: Prisma.Decimal;
      quantityShort: Prisma.Decimal;
    }>
  >`SELECT
      pa."quantityAllocated",
      poi."quantityReceived",
      poi."quantityShort"
    FROM "purchase_requirement_allocation" pa
    JOIN "purchase_order_item" poi ON poi.id = pa."purchaseOrderItemId"
    JOIN "purchase_order" po ON po.id = poi."purchaseOrderId"
    WHERE pa."requirementLineId" = ${lineId}
      AND po.status::text <> ${PurchaseOrderStatus.CANCELLED}`;

  let total = 0;
  for (const row of rows) {
    const allocated = row.quantityAllocated.toNumber();
    const received = row.quantityReceived.toNumber();
    // quantityShort defaults to 0 if not set (NULL in DB)
    const short = row.quantityShort ? row.quantityShort.toNumber() : 0;
    // Effective = what we'll actually receive = received + remaining (excluding short)
    const remainingToReceive = Math.max(0, allocated - received - short);
    total += received + remainingToReceive;
  }
  return total;
}

/**
 * Shared transactional creation path. Validates availability against true active
 * allocations (inside the line lock), creates the PO + items + allocations, and
 * recomputes requirement status — all or nothing.
 */
async function createPurchaseOrderTx(
  tx: Prisma.TransactionClient,
  input: ResolvedCreateInput,
  actor: Pick<AuthenticatedUser, "id">,
) {
  await assertSupplierActive(input.supplierId, tx);

  const lineIds = input.items
    .map((i) => i.requirementLineId)
    .filter((id): id is string => Boolean(id));
  await lockRequirementLines(tx, lineIds);

  const lines = lineIds.length
    ? await tx.purchaseRequirementLine.findMany({
        where: { id: { in: [...new Set(lineIds)] } },
        select: {
          id: true,
          requirementId: true,
          productId: true,
          quantityNeeded: true,
          quantityNeededBase: true,
          unitId: true,
          status: true,
        },
      })
    : [];
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const productIds = new Set<string>();
  const resolvedItems: Array<{
    productId: string;
    quantityOrdered: number;
    unitId: string | null;
    quantityOrderedBase: number;
    unitCost: number;
    requirementLineId: string | null;
  }> = [];
  // Reservation accounting is in BASE units so lines requested in different
  // units (Boxes vs Tablets) reconcile against one quantityNeededBase.
  const reservedByLine = new Map<string, number>();

  for (const item of input.items) {
    if (item.requirementLineId) {
      const line = lineById.get(item.requirementLineId);
      if (!line) {
        throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
      }
      if (line.status === PurchaseRequirementStatus.CLOSED) {
        throw new AppError(
          409,
          ErrorCode.REQUIREMENT_CLOSED,
          "Cannot order against a closed requirement line",
        );
      }
      if (item.productId && item.productId !== line.productId) {
        throw new AppError(
          422,
          ErrorCode.BAD_REQUEST,
          "Product does not match the requirement line's product",
        );
      }

      // Normalize the ordered quantity to base units. A line without unitId is
      // a legacy line interpreted in the product's base unit.
      const lineUnitId = line.unitId ?? (await baseUnitIdFor(tx, line.productId));
      const { baseQuantity } = await productUnitService.toBaseQuantity(
        line.productId,
        lineUnitId,
        item.quantityOrdered,
        tx,
      );
      const quantityOrderedBase = baseQuantity.toNumber();

      // Fulfillment math is entirely in base units.
      const required = line.quantityNeededBase.gt(0)
        ? line.quantityNeededBase.toNumber()
        : line.quantityNeeded.toNumber();
      const alreadyAllocated = await sumActiveAllocations(tx, line.id);
      const reserved = reservedByLine.get(line.id) ?? 0;
      const available = required - alreadyAllocated - reserved;
      if (quantityOrderedBase > available) {
        throw new AppError(
          409,
          ErrorCode.REQUIREMENT_QUANTITY_EXCEEDED,
          "Requested quantity exceeds the remaining quantity on the requirement line",
          {
            requiredQuantity: required,
            currentlyOrderedQuantity: alreadyAllocated + reserved,
            remainingQuantity: Math.max(0, available),
            requestedQuantity: quantityOrderedBase,
          },
        );
      }

      reservedByLine.set(line.id, reserved + quantityOrderedBase);
      productIds.add(line.productId);
      resolvedItems.push({
        productId: line.productId,
        quantityOrdered: item.quantityOrdered,
        unitId: lineUnitId,
        quantityOrderedBase,
        unitCost: item.unitCost,
        requirementLineId: line.id,
      });
    } else {
      if (!item.productId) {
        throw new AppError(
          422,
          ErrorCode.BAD_REQUEST,
          "Product is required for non-requirement items",
        );
      }
      productIds.add(item.productId);
      // Explicit unit when supplied; otherwise the product's base unit.
      const itemUnitId = item.unitId ?? (await baseUnitIdFor(tx, item.productId));
      const { baseQuantity } = await productUnitService.toBaseQuantity(
        item.productId,
        itemUnitId,
        item.quantityOrdered,
        tx,
      );
      resolvedItems.push({
        productId: item.productId,
        quantityOrdered: item.quantityOrdered,
        unitId: itemUnitId,
        quantityOrderedBase: baseQuantity.toNumber(),
        unitCost: item.unitCost,
        requirementLineId: null,
      });
    }
  }

  for (const pid of productIds) {
    await assertProductActive(pid, tx);
  }

  const po = await tx.purchaseOrder.create({
    data: {
      poNumber: generatePONumber(),
      supplierId: input.supplierId,
      expectedDeliveryDate: input.expectedDeliveryDate,
      notes: input.notes,
      status: PurchaseOrderStatus.REGISTERED,
      createdById: actor.id,
    },
  });

  for (const item of resolvedItems) {
    const createdItem = await tx.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: item.productId,
        quantityOrdered: item.quantityOrdered,
        // Conversion snapshot: base quantity never depends on the current
        // ProductUnit configuration.
        unitId: item.unitId,
        quantityOrderedBase: item.quantityOrderedBase,
        unitCost: item.unitCost,
        // Kept in sync for receiving/legacy queries; the allocation remains the
        // source of truth for ordered quantity.
        requirementLineId: item.requirementLineId,
      },
    });

    if (item.requirementLineId) {
      await tx.purchaseRequirementAllocation.create({
        data: {
          requirementLineId: item.requirementLineId,
          purchaseOrderItemId: createdItem.id,
          // Allocation is stored in BASE units so requirement fulfillment
          // reconciles across POs that ordered in different units.
          quantityAllocated: item.quantityOrderedBase,
        },
      });
    }
  }

  for (const requirementId of new Set(lines.map((l) => l.requirementId))) {
    await recomputeRequirementStatus(requirementId, tx);
  }

  const created = await tx.purchaseOrder.findUnique({
    where: { id: po.id },
    include: PO_DETAIL_INCLUDE,
  });

  // Audit inside the same transaction as the PO + allocations.
  await recordAuditEvent(
    {
      event: AuditEvent.PURCHASE_ORDER_CREATED,
      entityId: po.id,
      actorId: actor.id,
      metadata: {
        poNumber: po.poNumber,
        supplierId: po.supplierId,
        itemCount: resolvedItems.length,
      },
    },
    tx,
  );

  return purchaseOrderService.attachDetailSummaries(created!);
}

export const purchaseOrderService = {
  async list(query: POListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.PurchaseOrderWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { poNumber: { contains: query.search, mode: "insensitive" as const } },
              { notes: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    // Payment-status filtering happens at the query level: NOT_INVOICED is a
    // native relation filter; the other states use one aggregate query (one row
    // per PO with invoices) instead of loading full PO rows into memory.
    const paymentStatus = query.paymentStatus;
    if (paymentStatus && paymentStatus !== "ALL") {
      if (paymentStatus === PurchaseOrderPaymentStatus.NOT_INVOICED) {
        where.supplierInvoices = { none: {} };
      } else {
        const aggregates = await paymentAggregatesByPo();
        const matching = [...aggregates.entries()]
          .filter(([, summary]) => summary.status === paymentStatus)
          .map(([poId]) => poId);
        where.id = { in: matching };
      }
    }

    const [rawItems, total, statusGroups] = await prisma.$transaction([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.purchaseOrder.count({ where }),
      // Status counts over the FILTERED dataset (not just the page).
      prisma.purchaseOrder.groupBy({
        by: ["status"],
        where,
        orderBy: [],
        _count: true,
      }),
    ]);

    const countByStatus = new Map(statusGroups.map((g) => [g.status, g._count]));
    const summary = {
      registered: countByStatus.get("REGISTERED") ?? 0,
      awaitingDelivery: countByStatus.get("AWAITING_DELIVERY") ?? 0,
      received: countByStatus.get("RECEIVED") ?? 0,
      closed: countByStatus.get("CLOSED") ?? 0,
      cancelled: countByStatus.get("CANCELLED") ?? 0,
    };

    const items = await attachPaymentSummaries(rawItems);
    return { items, meta: buildPaginationMeta(total, page, limit), summary };
  },

  async create(input: CreatePOInput, actor: Pick<AuthenticatedUser, "id">) {
    return prisma.$transaction((tx) => createPurchaseOrderTx(tx, input, actor), TX_OPTIONS);
  },

  /**
   * Creates a purchase order whose items are all taken from requirement lines. The
   * product for each item is derived from the requirement line, so the client only
   * needs to pick a supplier and the quantity.
   */
  async createFromRequirement(
    input: CreatePOFromRequirementInput,
    actor: Pick<AuthenticatedUser, "id">,
  ) {
    return prisma.$transaction((tx) =>
      createPurchaseOrderTx(
        tx,
        {
          supplierId: input.supplierId,
          expectedDeliveryDate: input.expectedDeliveryDate,
          notes: input.notes,
          items: input.items.map((item) => ({
            requirementLineId: item.requirementLineId,
            quantityOrdered: item.quantityOrdered,
            unitCost: item.unitCost,
          })),
        },
        actor,
      ),
      TX_OPTIONS,
    );
  },

  async getById(id: string) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: PO_DETAIL_INCLUDE,
    });

    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }

    return this.attachDetailSummaries(po);
  },

  /**
   * Attaches the summary dimensions of a PO to a detail response:
   *  - receivingSummary: ordered/received/short/remaining quantities
   *  - goodsSummary: orderedGoodsValue / receivedGoodsValue /
   *    goodsInvoicedAmount / remainingGoodsToInvoice — three DIFFERENT
   *    financial concepts (commercial order value, value of received goods,
   *    value of goods billed on invoices)
   *  - paymentSummary: derived from ALL of the PO's invoice totals and their
   *    payments (invoicedAmount = SUM(totalAmount), never the goods amount)
   */
  async attachDetailSummaries<
    T extends {
      id: string;
      status: PurchaseOrderStatus;
      items: Array<{
        quantityOrdered: Prisma.Decimal;
        quantityReceived: Prisma.Decimal;
        quantityShort: Prisma.Decimal;
        unitCost: Prisma.Decimal;
      }>;
      supplierInvoices?: Array<{
        totalAmount: Prisma.Decimal;
        outstandingBalance: Prisma.Decimal;
        goodsAmount: Prisma.Decimal;
      }>;
    },
  >(po: T): Promise<Omit<T, "items" | "supplierInvoices"> & {
    receivingSummary: POReceivingSummary;
    goodsSummary: POGoodsSummary;
    paymentSummary: PopaymentSummary;
    items: T["items"];
    supplierInvoices?: T["supplierInvoices"];
  }> {
    const receivingSummary = buildReceivingSummary(po.items);

    // Goods values are per-item monetary derivations (quantity x unitCost).
    // Received goods value uses received quantities only — accepted shortages
    // are never delivered and never billed.
    const zero = new Prisma.Decimal(0);
    const orderedGoodsValue = po.items.reduce(
      (sum, i) => sum.plus(i.quantityOrdered.mul(i.unitCost)),
      zero,
    );
    const receivedGoodsValue = po.items.reduce(
      (sum, i) => sum.plus(i.quantityReceived.mul(i.unitCost)),
      zero,
    );

    let goodsSummary: POGoodsSummary;
    let paymentSummary: PopaymentSummary;
    if ((po as { supplierInvoices?: unknown }).supplierInvoices !== undefined) {
      const invoices = po.supplierInvoices ?? [];
      const invoicedTotal = invoices.reduce(
        (sum, inv) => sum.plus(inv.totalAmount),
        zero,
      );
      const outstanding = invoices.reduce(
        (sum, inv) => sum.plus(inv.outstandingBalance),
        zero,
      );
      const goodsInvoiced = invoices.reduce(
        (sum, inv) => sum.plus(inv.goodsAmount),
        zero,
      );
      goodsSummary = {
        orderedGoodsValue: roundMoney(orderedGoodsValue),
        receivedGoodsValue: roundMoney(receivedGoodsValue),
        goodsInvoicedAmount: roundMoney(goodsInvoiced),
        remainingGoodsToInvoice: roundMoney(
          Prisma.Decimal.max(receivedGoodsValue.minus(goodsInvoiced), zero),
        ),
      };
      paymentSummary = {
        status: derivePaymentStatus({
          invoiceCount: invoices.length,
          invoicedAmount: invoicedTotal,
          outstandingAmount: outstanding,
        }),
        invoiceCount: invoices.length,
        invoicedAmount: roundMoney(invoicedTotal),
        paidAmount: roundMoney(invoicedTotal.minus(outstanding)),
        outstandingAmount: roundMoney(outstanding),
      };
    } else {
      const [goodsAgg, aggregates] = await Promise.all([
        prisma.supplierInvoiceItem.aggregate({
          where: { invoice: { purchaseOrderId: po.id } },
          _sum: { goodsAmount: true },
        }),
        paymentAggregatesByPo(),
      ]);
      const goodsInvoiced = goodsAgg._sum.goodsAmount ?? zero;
      goodsSummary = {
        orderedGoodsValue: roundMoney(orderedGoodsValue),
        receivedGoodsValue: roundMoney(receivedGoodsValue),
        goodsInvoicedAmount: roundMoney(goodsInvoiced),
        remainingGoodsToInvoice: roundMoney(
          Prisma.Decimal.max(receivedGoodsValue.minus(goodsInvoiced), zero),
        ),
      };
      paymentSummary =
        aggregates.get(po.id) ??
        ({
          status: PurchaseOrderPaymentStatus.NOT_INVOICED,
          invoiceCount: 0,
          invoicedAmount: 0,
          paidAmount: 0,
          outstandingAmount: 0,
        } satisfies PopaymentSummary);
    }

    const { items, supplierInvoices, ...rest } = po;
    return {
      ...rest,
      receivingSummary,
      goodsSummary,
      paymentSummary,
      items,
      ...(supplierInvoices !== undefined ? { supplierInvoices } : {}),
    } as Omit<T, "items" | "supplierInvoices"> & {
      receivingSummary: POReceivingSummary;
      goodsSummary: POGoodsSummary;
      paymentSummary: PopaymentSummary;
      items: T["items"];
      supplierInvoices?: T["supplierInvoices"];
    };
  },

  /**
   * Accepts the outstanding quantity of a PO item as an explicit shortage.
   *
   * The shortage is pure reconciliation: it never increases stock and never
   * increments requirement fulfillment. Once received + short covers ordered,
   * the PO can progress to RECEIVED.
   */
  async acceptShortage(
    itemId: string,
    input: { quantityShort?: number; shortReason?: string | null },
  ) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.purchaseOrderItem.findUnique({
        where: { id: itemId },
        include: { purchaseOrder: { select: { id: true, status: true } } },
      });
      if (!item) {
        throw new AppError(
          404,
          ErrorCode.PURCHASE_ORDER_ITEM_NOT_FOUND,
          "Purchase order item not found",
        );
      }
      const poStatus = item.purchaseOrder.status;
      if (
        poStatus === PurchaseOrderStatus.CANCELLED ||
        poStatus === PurchaseOrderStatus.CLOSED ||
        poStatus === PurchaseOrderStatus.RECEIVED
      ) {
        throw new AppError(
          409,
          ErrorCode.PO_STATUS_TRANSITION_INVALID,
          "Shortage can only be accepted on an open order",
        );
      }

      const quantityShort =
        input.quantityShort !== undefined
          ? new Prisma.Decimal(input.quantityShort)
          : item.quantityOrdered.minus(item.quantityReceived).minus(item.quantityShort);

      if (quantityShort.lte(0)) {
        throw new AppError(
          422,
          ErrorCode.BAD_REQUEST,
          "Shortage quantity must be greater than zero",
        );
      }
      if (item.quantityReceived.plus(item.quantityShort).plus(quantityShort).gt(item.quantityOrdered)) {
        throw new AppError(
          422,
          ErrorCode.BAD_REQUEST,
          "Received + short cannot exceed the ordered quantity",
          {
            quantityOrdered: item.quantityOrdered.toNumber(),
            quantityReceived: item.quantityReceived.toNumber(),
            quantityShort: item.quantityShort.toNumber(),
            requestedShort: quantityShort.toNumber(),
          },
        );
      }

      await tx.purchaseOrderItem.update({
        where: { id: itemId },
        data: {
          quantityShort: item.quantityShort.plus(quantityShort),
          shortReason: input.shortReason ?? undefined,
        },
      });

      // Move the PO to RECEIVED when every item is fully accounted for.
      const poItems = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: item.purchaseOrderId },
        select: { id: true, quantityOrdered: true, quantityReceived: true, quantityShort: true },
      });
      if (poItems.every(isItemFullyAccountedFor)) {
        await tx.purchaseOrder.update({
          where: { id: item.purchaseOrderId },
          data: { status: PurchaseOrderStatus.RECEIVED },
        });
      }

      const updated = await tx.purchaseOrderItem.findUnique({
        where: { id: itemId },
        include: {
          product: { select: { id: true, name: true, sku: true } },
        },
      });
      return updated;
    }, TX_OPTIONS);
  },

  async update(id: string, input: UpdatePOInput, actor?: Pick<AuthenticatedUser, "id">) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status === PurchaseOrderStatus.CANCELLED || po.status === PurchaseOrderStatus.CLOSED) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Cannot modify a cancelled or closed order",
      );
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: {
        expectedDeliveryDate: input.expectedDeliveryDate,
        notes: input.notes,
      },
      include: PO_DETAIL_INCLUDE,
    });

    // Non-transactional single write: audit after the commit; the helper
    // swallows failures for already-committed operations.
    await recordAuditEvent({
      event: AuditEvent.PURCHASE_ORDER_UPDATED,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: {
        poNumber: updated.poNumber,
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        notesChanged: input.notes !== undefined,
      },
    });

    return this.attachDetailSummaries(updated);
  },

  /**
   * Edits a single order item. When the item fulfills a requirement line, the linked
   * allocation is resized and validated against the *other* active allocations on
   * that line (not against the naive original remaining quantity).
   */
  async updateItem(itemId: string, input: UpdatePOItemInput) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseOrderItem.findUnique({
        where: { id: itemId },
        include: {
          purchaseOrder: { select: { id: true, status: true } },
          allocations: true,
        },
      });
      if (!existing) {
        throw new AppError(
          404,
          ErrorCode.PURCHASE_ORDER_ITEM_NOT_FOUND,
          "Purchase order item not found",
        );
      }
      const status = existing.purchaseOrder.status;
      if (
        status === PurchaseOrderStatus.CANCELLED ||
        status === PurchaseOrderStatus.CLOSED ||
        status === PurchaseOrderStatus.RECEIVED
      ) {
        throw new AppError(
          409,
          ErrorCode.PO_STATUS_TRANSITION_INVALID,
          "Cannot edit items on a received, cancelled or closed order",
        );
      }

      const allocation = existing.allocations[0];
      let requirementId: string | null = null;

      if (input.quantityOrdered !== undefined) {
        if (input.quantityOrdered < existing.quantityReceived.toNumber()) {
          throw new AppError(
            409,
            ErrorCode.PO_STATUS_TRANSITION_INVALID,
            "Ordered quantity cannot be reduced below the quantity already received",
          );
        }

        if (allocation) {
          await lockRequirementLines(tx, [allocation.requirementLineId]);
          const line = await tx.purchaseRequirementLine.findUnique({
            where: { id: allocation.requirementLineId },
            select: { id: true, requirementId: true, quantityNeeded: true, quantityNeededBase: true },
          });
          if (!line) {
            throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
          }
          requirementId = line.requirementId;

          // The item is ordered in its own unit; convert the new ordered
          // quantity to BASE so it reconciles against the requirement's
          // base snapshot and the base-valued allocations on the same line.
          const itemUnitId = existing.unitId ?? (await baseUnitIdFor(tx, existing.productId));
          const { baseQuantity: newOrderedBaseQuantity } = await productUnitService.toBaseQuantity(
            existing.productId,
            itemUnitId,
            input.quantityOrdered,
            tx,
          );
          const newOrderedBase = newOrderedBaseQuantity.toNumber();

          const othersAggregate = await tx.purchaseRequirementAllocation.aggregate({
            where: {
              requirementLineId: allocation.requirementLineId,
              purchaseOrderItemId: { not: existing.id },
              purchaseOrderItem: {
                purchaseOrder: { status: { not: PurchaseOrderStatus.CANCELLED } },
              },
            },
            _sum: { quantityAllocated: true },
          });
          const otherAllocated = othersAggregate._sum.quantityAllocated?.toNumber() ?? 0;
          const requiredBase = line.quantityNeededBase.gt(0)
            ? line.quantityNeededBase.toNumber()
            : line.quantityNeeded.toNumber();
          const maxAllowed = requiredBase - otherAllocated;
          if (newOrderedBase > maxAllowed) {
            throw new AppError(
              409,
              ErrorCode.REQUIREMENT_QUANTITY_EXCEEDED,
              "Requested quantity exceeds the remaining quantity on the requirement line",
              {
                requiredQuantity: requiredBase,
                currentlyOrderedQuantity: otherAllocated,
                remainingQuantity: Math.max(0, maxAllowed),
                requestedQuantity: newOrderedBase,
              },
            );
          }

          await tx.purchaseRequirementAllocation.update({
            where: { id: allocation.id },
            data: { quantityAllocated: newOrderedBase },
          });

          await tx.purchaseOrderItem.update({
            where: { id: itemId },
            data: {
              quantityOrdered: input.quantityOrdered,
              // Base snapshot stays in sync; never re-read the current
              // ProductUnit configuration for historical rows.
              quantityOrderedBase: newOrderedBase,
            },
          });
        } else {
          const itemUnitId = existing.unitId ?? (await baseUnitIdFor(tx, existing.productId));
          const { baseQuantity: newOrderedBaseQuantity } = await productUnitService.toBaseQuantity(
            existing.productId,
            itemUnitId,
            input.quantityOrdered,
            tx,
          );
          await tx.purchaseOrderItem.update({
            where: { id: itemId },
            data: {
              quantityOrdered: input.quantityOrdered,
              quantityOrderedBase: newOrderedBaseQuantity.toNumber(),
            },
          });
        }

        await tx.purchaseOrderItem.update({
          where: { id: itemId },
          data: { quantityOrdered: input.quantityOrdered },
        });
      }

      if (input.unitCost !== undefined) {
        await tx.purchaseOrderItem.update({
          where: { id: itemId },
          data: { unitCost: input.unitCost },
        });
      }

      if (requirementId) {
        await recomputeRequirementStatus(requirementId, tx);
      }

      return tx.purchaseOrderItem.findUnique({
        where: { id: itemId },
        include: {
          product: { select: { id: true, name: true, sku: true } },
          allocations: { select: { id: true, requirementLineId: true, quantityAllocated: true } },
        },
      });
    }, TX_OPTIONS);
  },

  /**
   * Removes an item from a draft (REGISTERED) order and releases its requirement
   * allocation. Received/confirmed orders keep their history.
   */
  async removeItem(itemId: string) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseOrderItem.findUnique({
        where: { id: itemId },
        include: {
          purchaseOrder: { select: { id: true, status: true } },
          allocations: { select: { id: true, requirementLineId: true } },
        },
      });
      if (!existing) {
        throw new AppError(
          404,
          ErrorCode.PURCHASE_ORDER_ITEM_NOT_FOUND,
          "Purchase order item not found",
        );
      }
      if (existing.purchaseOrder.status !== PurchaseOrderStatus.REGISTERED) {
        throw new AppError(
          409,
          ErrorCode.PO_STATUS_TRANSITION_INVALID,
          "Only items on a registered order can be removed",
        );
      }
      if (existing.quantityReceived.greaterThan(0)) {
        throw new AppError(
          409,
          ErrorCode.PO_STATUS_TRANSITION_INVALID,
          "Cannot remove an item that has received quantity",
        );
      }

      const lineIds = existing.allocations.map((a) => a.requirementLineId);
      await lockRequirementLines(tx, lineIds);
      const affectedLines = lineIds.length
        ? await tx.purchaseRequirementLine.findMany({
            where: { id: { in: lineIds } },
            select: { requirementId: true },
          })
        : [];

      // Allocations cascade when the item is deleted.
      await tx.purchaseOrderItem.delete({ where: { id: itemId } });

      for (const requirementId of new Set(affectedLines.map((l) => l.requirementId))) {
        await recomputeRequirementStatus(requirementId, tx);
      }
    }, TX_OPTIONS);
  },

  /**
   * Cancels a purchase order. Because allocations are only "active" while the PO is
   * not cancelled, this automatically releases the ordered quantity back to every
   * requirement line it was fulfilling and recomputes their status.
   */
  async cancel(id: string, _actor: Pick<AuthenticatedUser, "id">) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          items: {
            select: { id: true, requirementLineId: true, quantityReceived: true },
          },
        },
      });
      if (!po) {
        throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
      }
      if (
        po.status === PurchaseOrderStatus.RECEIVED ||
        po.status === PurchaseOrderStatus.CLOSED ||
        po.status === PurchaseOrderStatus.CANCELLED
      ) {
        throw new AppError(
          409,
          ErrorCode.PO_CANNOT_CANCEL,
          "Cannot cancel an order that has been received or closed",
        );
      }
      if (po.items.some((i) => i.quantityReceived.greaterThan(0))) {
        throw new AppError(
          409,
          ErrorCode.PO_CANNOT_CANCEL,
          "Cannot cancel an order with received quantities",
        );
      }

      const lineIds = po.items.map((i) => i.requirementLineId);
      await lockRequirementLines(tx, lineIds);
      const lines = lineIds.length
        ? await tx.purchaseRequirementLine.findMany({
            where: { id: { in: lineIds.filter((l): l is string => Boolean(l)) } },
            select: { requirementId: true },
          })
        : [];

      await tx.purchaseOrder.update({
        where: { id },
        data: { status: PurchaseOrderStatus.CANCELLED },
      });

      for (const requirementId of new Set(lines.map((l) => l.requirementId))) {
        await recomputeRequirementStatus(requirementId, tx);
      }

      await recordAuditEvent(
        {
          event: AuditEvent.PURCHASE_ORDER_CANCELLED,
          entityId: id,
          actorId: _actor.id,
          metadata: { poNumber: po.poNumber },
        },
        tx,
      );

      const cancelled = await tx.purchaseOrder.findUnique({ where: { id }, include: PO_DETAIL_INCLUDE });
      return purchaseOrderService.attachDetailSummaries(cancelled!);
    }, TX_OPTIONS);
  },

  async markAwaitingDelivery(id: string, actor?: Pick<AuthenticatedUser, "id">) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status !== PurchaseOrderStatus.REGISTERED) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Only registered orders can be marked as awaiting delivery",
      );
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.AWAITING_DELIVERY },
      include: PO_DETAIL_INCLUDE,
    });
    await recordAuditEvent({
      event: AuditEvent.PURCHASE_ORDER_MARKED_AWAITING_DELIVERY,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: { poNumber: updated.poNumber },
    });
    return this.attachDetailSummaries(updated);
  },

  async close(id: string, actor?: Pick<AuthenticatedUser, "id">) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: { select: { id: true, quantityOrdered: true, quantityReceived: true, quantityShort: true } },
      },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status !== PurchaseOrderStatus.RECEIVED) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Only received orders can be closed",
      );
    }

    const incomplete = po.items.some(
      (i) => !isItemFullyAccountedFor(i as never),
    );
    if (incomplete) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Cannot close order with items that are not fully received or accepted as short",
      );
    }

    const closed = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.CLOSED },
      include: PO_DETAIL_INCLUDE,
    });
    await recordAuditEvent({
      event: AuditEvent.PURCHASE_ORDER_CLOSED,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: { poNumber: closed.poNumber },
    });
    return this.attachDetailSummaries(closed);
  },
};
