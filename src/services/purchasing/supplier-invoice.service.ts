import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { toDecimal } from "../../utils/decimal.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type InvoiceItemInput = {
  purchaseOrderItemId: string;
  /** Quantity invoiced, in the PO item's ordered unit. */
  quantity: number;
  /** Optional unit-cost override; defaults to the PO item's unitCost. */
  unitCost?: number;
};

export type CreateSupplierInvoiceInput = {
  invoiceNumber: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  invoiceDate?: Date;
  dueDate?: Date | null;
  /**
   * Value of received goods being billed. For PO-linked invoices this is
   * derived from the item allocations; otherwise it is the client-supplied
   * amount.
   */
  goodsAmount?: number;
  taxAmount?: number;
  additionalChargesAmount?: number;
  discountAmount?: number;
  paymentTerms?: string | null;
  /** PO-linked invoices allocate goods to specific PO items. */
  items?: InvoiceItemInput[];
};

export type UpdateSupplierInvoiceInput = Partial<{
  dueDate: Date | null;
  paymentTerms: string | null;
}>;

export type RecordPaymentInput = {
  amount: number;
  paymentDate?: Date;
  notes?: string | null;
};

export type SupplierInvoiceListQuery = PageQuery & {
  supplierId?: string;
  status?: "OPEN" | "PARTIALLY_PAID" | "PAID";
  search?: string;
};

function money(value: number | Prisma.Decimal): Prisma.Decimal {
  const decimal = value instanceof Prisma.Decimal ? value : toDecimal(value);
  return decimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** totalAmount = goods + tax + charges - discount (never negative). */
export function computeInvoiceTotal(parts: {
  goodsAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  additionalChargesAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
}): Prisma.Decimal {
  return money(
    parts.goodsAmount
      .plus(parts.taxAmount)
      .plus(parts.additionalChargesAmount)
      .minus(parts.discountAmount),
  );
}

function statusForOutstanding(outstanding: Prisma.Decimal, totalAmount: Prisma.Decimal) {
  if (outstanding.lte(0)) return "PAID" as const;
  if (outstanding.lt(totalAmount)) return "PARTIALLY_PAID" as const;
  return "OPEN" as const;
}

async function assertSupplierActive(supplierId: string) {
  const supplier = await prisma.supplier.findUnique({
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

const INVOICE_DETAIL_INCLUDE = {
  supplier: { select: { id: true, name: true, contactPerson: true, email: true, phone: true } },
  purchaseOrder: { select: { id: true, poNumber: true } },
  createdBy: { select: { id: true, name: true } },
  payments: {
    include: { recordedBy: { select: { id: true, name: true } } },
    orderBy: { paymentDate: "desc" as const },
  },
  items: {
    include: {
      purchaseOrderItem: {
        select: {
          id: true,
          productId: true,
          product: { select: { id: true, name: true, sku: true } },
          quantityOrdered: true,
          quantityReceived: true,
          unit: { select: { id: true, name: true, symbol: true } },
        },
      },
      unit: { select: { id: true, name: true, symbol: true } },
    },
  },
} as Prisma.SupplierInvoiceInclude;

type ValidatedAllocation = {
  purchaseOrderItemId: string;
  quantity: Prisma.Decimal;
  unitId: string | null;
  unitCost: Prisma.Decimal;
  goodsAmount: Prisma.Decimal;
};

/**
 * Validates the goods allocation for a PO-linked invoice inside the caller's
 * transaction:
 *  - every PO item belongs to the invoice's PO
 *  - invoiced quantity (this request + previously invoiced quantities across
 *    ALL invoices of the PO) never exceeds the received quantity of the item
 *
 * The row lock on the purchase_order_item rows is the serialization point
 * against concurrent invoice creations for the same received goods.
 */
async function validateGoodsAllocation(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  items: InvoiceItemInput[],
): Promise<ValidatedAllocation[]> {
  if (items.length === 0) {
    throw new AppError(
      422,
      ErrorCode.BAD_REQUEST,
      "A PO-linked invoice must allocate its goods to at least one purchase order item",
    );
  }

  const poItemIds = [...new Set(items.map((i) => i.purchaseOrderItemId))].sort();

  // Serialization point against concurrent invoices for the same goods.
  await tx.$queryRaw`SELECT id FROM "purchase_order_item" WHERE id IN (${Prisma.join(poItemIds)}) FOR UPDATE`;

  const poItems = await tx.purchaseOrderItem.findMany({
    where: { id: { in: poItemIds }, purchaseOrderId },
    select: {
      id: true,
      quantityReceived: true,
      unitId: true,
      unitCost: true,
    },
  });
  const poItemById = new Map(poItems.map((p) => [p.id, p]));
  if (poItemById.size !== poItemIds.length) {
    throw new AppError(
      422,
      ErrorCode.BAD_REQUEST,
      "One or more purchase order items do not belong to the specified purchase order",
    );
  }

  // Already-invoiced quantities per PO item across ALL invoices of this PO.
  const previouslyInvoiced = await tx.supplierInvoiceItem.groupBy({
    by: ["purchaseOrderItemId"],
    where: {
      purchaseOrderItemId: { in: poItemIds },
      invoice: { purchaseOrderId },
    },
    _sum: { quantity: true },
  });
  const invoicedByItem = new Map(
    previouslyInvoiced.map((row) => [
      row.purchaseOrderItemId,
      row._sum.quantity ?? new Prisma.Decimal(0),
    ]),
  );

  const seen = new Set<string>();
  const validated: ValidatedAllocation[] = [];

  for (const item of items) {
    if (seen.has(item.purchaseOrderItemId)) {
      throw new AppError(
        422,
        ErrorCode.BAD_REQUEST,
        "The same purchase order item cannot be allocated twice in one invoice",
      );
    }
    seen.add(item.purchaseOrderItemId);

    const poItem = poItemById.get(item.purchaseOrderItemId)!;
    const quantity = toDecimal(item.quantity);
    if (quantity.lte(0)) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Invoiced quantity must be greater than zero");
    }

    const alreadyInvoiced = invoicedByItem.get(poItem.id) ?? new Prisma.Decimal(0);
    const totalInvoiced = alreadyInvoiced.plus(quantity);
    if (totalInvoiced.gt(poItem.quantityReceived)) {
      throw new AppError(
        422,
        ErrorCode.SUPPLIER_INVOICE_EXCEEDS_RECEIVED,
        "Invoiced quantity exceeds the received-but-not-yet-invoiced quantity",
        {
          purchaseOrderItemId: poItem.id,
          quantityReceived: poItem.quantityReceived.toNumber(),
          alreadyInvoiced: alreadyInvoiced.toNumber(),
          requested: quantity.toNumber(),
          remainingGoodsToInvoice: Math.max(
            0,
            poItem.quantityReceived.minus(alreadyInvoiced).toNumber(),
          ),
        },
      );
    }

    const unitCost = item.unitCost !== undefined ? money(item.unitCost) : poItem.unitCost;
    if (unitCost.lte(0)) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Unit cost must be greater than zero");
    }

    invoicedByItem.set(poItem.id, totalInvoiced);
    validated.push({
      purchaseOrderItemId: poItem.id,
      quantity,
      unitId: poItem.unitId,
      unitCost,
      goodsAmount: money(quantity.mul(unitCost)),
    });
  }

  return validated;
}

export const supplierInvoiceService = {
  async list(query: SupplierInvoiceListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.SupplierInvoiceWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { invoiceNumber: { contains: query.search, mode: "insensitive" as const } },
              { supplier: { name: { contains: query.search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.supplierInvoice.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          createdBy: { select: { id: true, name: true } },
          payments: {
            select: { id: true, amount: true, paymentDate: true },
            orderBy: { paymentDate: "desc" },
            take: 5,
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.supplierInvoice.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /**
   * Creates a supplier invoice atomically.
   *
   * PO-linked invoices MUST allocate their goods to specific PO items; the
   * goods amount is derived from those allocations (quantity x unitCost) and
   * validated against received-but-not-yet-invoiced quantities inside the
   * transaction — the same received goods can never be invoiced twice, even
   * under concurrent requests.
   *
   * Non-PO invoices keep the simple flow: the client supplies goodsAmount; tax,
   * charges and discount are applied server-side to compute the total.
   */
  async create(input: CreateSupplierInvoiceInput, actor: Pick<AuthenticatedUser, "id">) {
    await assertSupplierActive(input.supplierId);

    const duplicate = await prisma.supplierInvoice.findUnique({
      where: {
        supplierId_invoiceNumber: {
          supplierId: input.supplierId,
          invoiceNumber: input.invoiceNumber,
        },
      },
    });
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_INVOICE_NUMBER, "Invoice number already exists for this supplier");
    }

    let po: { id: string; supplierId: string } | null = null;
    if (input.purchaseOrderId) {
      const found = await prisma.purchaseOrder.findUnique({
        where: { id: input.purchaseOrderId },
        select: { id: true, supplierId: true },
      });
      if (!found) {
        throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
      }
      if (found.supplierId !== input.supplierId) {
        throw new AppError(422, ErrorCode.BAD_REQUEST, "Purchase order belongs to a different supplier");
      }
      po = found;
    }

    const taxAmount = money(input.taxAmount ?? 0);
    const additionalChargesAmount = money(input.additionalChargesAmount ?? 0);
    const discountAmount = money(input.discountAmount ?? 0);
    if (taxAmount.lt(0) || additionalChargesAmount.lt(0) || discountAmount.lt(0)) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Tax, charges and discount must be non-negative");
    }

    return prisma.$transaction(async (tx) => {
      let goodsAmount: Prisma.Decimal;
      const invoiceItems: ValidatedAllocation[] = [];

      if (po) {
        const allocations = await validateGoodsAllocation(tx, po.id, input.items ?? []);
        invoiceItems.push(...allocations);
        goodsAmount = allocations.reduce(
          (sum, a) => sum.plus(a.goodsAmount),
          new Prisma.Decimal(0),
        );
        // If the client also supplied goodsAmount it must agree with the
        // allocation - no silent over-billing.
        if (input.goodsAmount !== undefined && !money(input.goodsAmount).equals(goodsAmount)) {
          throw new AppError(
            422,
            ErrorCode.BAD_REQUEST,
            "goodsAmount does not match the goods allocated to purchase order items",
            { allocatedGoodsAmount: goodsAmount.toNumber(), suppliedGoodsAmount: input.goodsAmount },
          );
        }
      } else {
        if (input.goodsAmount === undefined || input.goodsAmount <= 0) {
          throw new AppError(422, ErrorCode.BAD_REQUEST, "goodsAmount is required for a non-PO invoice");
        }
        goodsAmount = money(input.goodsAmount);
      }

      const totalAmount = computeInvoiceTotal({
        goodsAmount,
        taxAmount,
        additionalChargesAmount,
        discountAmount,
      });
      if (totalAmount.lt(0)) {
        throw new AppError(422, ErrorCode.BAD_REQUEST, "Invoice total cannot be negative");
      }      const invoice = await tx.supplierInvoice.create({
          data: {
            invoiceNumber: input.invoiceNumber,
          supplierId: input.supplierId,
          purchaseOrderId: po?.id ?? null,
          invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : new Date(),
          dueDate: input.dueDate,
          goodsAmount,
          taxAmount,
          additionalChargesAmount,
          discountAmount,
          totalAmount,
          // Legacy field mirrors totalAmount so old consumers keep working.
          invoiceAmount: totalAmount,
          paymentTerms: input.paymentTerms,
          outstandingBalance: totalAmount,
          status: "OPEN",
          createdById: actor.id,
          items: {
            create: invoiceItems.map((item) => ({
              purchaseOrderItemId: item.purchaseOrderItemId,
              quantity: item.quantity,
              unitId: item.unitId,
              unitCost: item.unitCost,
              goodsAmount: item.goodsAmount,
            })),
          },
        },
        include: INVOICE_DETAIL_INCLUDE,
      });

      await recordAuditEvent(
        {
          event: AuditEvent.SUPPLIER_INVOICE_CREATED,
          entityId: invoice.id,
          actorId: actor.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            supplierId: invoice.supplierId,
            purchaseOrderId: invoice.purchaseOrderId,
            totalAmount: totalAmount.toNumber(),
          },
        },
        tx,
      );

      return invoice;
    }, { timeout: 30_000, maxWait: 15_000 });
  },

  async getById(id: string) {
    const invoice = await prisma.supplierInvoice.findUnique({
      where: { id },
      include: INVOICE_DETAIL_INCLUDE,
    });

    if (!invoice) {
      throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
    }

    return invoice;
  },

  async update(id: string, input: UpdateSupplierInvoiceInput, actor?: Pick<AuthenticatedUser, "id">) {
    const invoice = await prisma.supplierInvoice.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!invoice) {
      throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
    }
    if (invoice.status === "PAID") {
      throw new AppError(409, ErrorCode.BAD_REQUEST, "Cannot modify a fully paid invoice");
    }

    const updated = await prisma.supplierInvoice.update({
      where: { id },
      data: input,
    });

    await recordAuditEvent({
      event: AuditEvent.SUPPLIER_INVOICE_UPDATED,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: { invoiceNumber: updated.invoiceNumber },
    });

    return updated;
  },

  /**
   * Records a payment against the invoice TOTAL.
   *
   * The outstanding check happens INSIDE the transaction, guarded by a
   * conditional update (WHERE outstandingBalance >= amount) so two concurrent
   * payments can never jointly over-allocate the balance: the loser of the race
   * matches zero rows and fails with PAYMENT_EXCEEDS_BALANCE.
   */
  async recordPayment(invoiceId: string, input: RecordPaymentInput, actor: Pick<AuthenticatedUser, "id">) {
    return prisma.$transaction(async (tx) => {
      const invoice = await tx.supplierInvoice.findUnique({
        where: { id: invoiceId },
        select: { supplierId: true, outstandingBalance: true, totalAmount: true },
      });
      if (!invoice) {
        throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
      }
      if (invoice.outstandingBalance.lessThan(input.amount)) {
        throw new AppError(
          422,
          ErrorCode.SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE,
          "Payment amount exceeds outstanding balance",
          { outstanding: invoice.outstandingBalance.toNumber(), requested: input.amount }
        );
      }

      const payment = await tx.supplierPayment.create({
        data: {
          supplierInvoiceId: invoiceId,
          supplierId: invoice.supplierId,
          amount: input.amount,
          paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
          notes: input.notes,
          recordedById: actor.id,
        },
        include: { recordedBy: { select: { id: true, name: true } } },
      });

      const newOutstanding = invoice.outstandingBalance.minus(input.amount);

      // Conditional update: only succeeds if no concurrent payment has already
      // consumed the balance. Prevents overpayment under concurrency.
      const updated = await tx.supplierInvoice.updateMany({
        where: { id: invoiceId, outstandingBalance: { gte: input.amount } },
        data: {
          outstandingBalance: newOutstanding,
          status: statusForOutstanding(newOutstanding, invoice.totalAmount),
        },
      });
      if (updated.count === 0) {
        throw new AppError(
          422,
          ErrorCode.SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE,
          "Payment amount exceeds outstanding balance",
          { outstanding: invoice.outstandingBalance.toNumber(), requested: input.amount }
        );
      }

      // Audit inside the same transaction: the payment and the balance
      // decrement must commit or roll back together with this event.
      await recordAuditEvent(
        {
          event: AuditEvent.SUPPLIER_PAYMENT_RECORDED,
          entityId: payment.id,
          actorId: actor.id,
          metadata: {
            invoiceId,
            invoiceNumber: undefined,
            supplierId: invoice.supplierId,
            amount: input.amount,
            newOutstandingBalance: newOutstanding.toNumber(),
          },
        },
        tx,
      );

      return payment;
    });
  },

  async remove(id: string, actor?: Pick<AuthenticatedUser, "id">) {
    const invoice = await prisma.supplierInvoice.findUnique({
      where: { id },
      select: { id: true, invoiceNumber: true, status: true, _count: { select: { payments: true } } },
    });
    if (!invoice) {
      throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
    }
    if (invoice._count.payments > 0) {
      throw new AppError(409, ErrorCode.BAD_REQUEST, "Cannot delete invoice with recorded payments");
    }

    await prisma.supplierInvoice.delete({ where: { id } });

    await recordAuditEvent({
      event: AuditEvent.SUPPLIER_INVOICE_DELETED,
      entityId: id,
      actorId: actor?.id ?? null,
      metadata: { invoiceNumber: invoice.invoiceNumber },
    });
  },
};
