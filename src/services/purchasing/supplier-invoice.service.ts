import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreateSupplierInvoiceInput = {
  invoiceNumber: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  invoiceDate?: Date;
  dueDate?: Date | null;
  invoiceAmount: number;
  paymentTerms?: string | null;
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

async function assertInvoiceOutstanding(invoiceId: string, amount: number) {
  const invoice = await prisma.supplierInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, outstandingBalance: true, status: true },
  });
  if (!invoice) {
    throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
  }
  if (invoice.outstandingBalance.lessThan(amount)) {
    throw new AppError(
      422,
      ErrorCode.SUPPLIER_INVOICE_PAYMENT_EXCEEDS_BALANCE,
      "Payment amount exceeds outstanding balance",
      { outstanding: invoice.outstandingBalance.toNumber(), requested: amount }
    );
  }
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

  async create(input: CreateSupplierInvoiceInput, actor: Pick<AuthenticatedUser, "id">) {
    await assertSupplierActive(input.supplierId);

    // Check duplicate invoice number for supplier
    const existing = await prisma.supplierInvoice.findUnique({
      where: {
        supplierId_invoiceNumber: {
          supplierId: input.supplierId,
          invoiceNumber: input.invoiceNumber,
        },
      },
    });
    if (existing) {
      throw new AppError(409, ErrorCode.DUPLICATE_INVOICE_NUMBER, "Invoice number already exists for this supplier");
    }

    // Validate purchase order if provided
    if (input.purchaseOrderId) {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: input.purchaseOrderId },
        select: { id: true, supplierId: true, status: true },
      });
      if (!po) {
        throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
      }
      if (po.supplierId !== input.supplierId) {
        throw new AppError(422, ErrorCode.BAD_REQUEST, "Purchase order belongs to a different supplier");
      }
    }

    const invoice = await prisma.supplierInvoice.create({
      data: {
        invoiceNumber: input.invoiceNumber,
        supplierId: input.supplierId,
        purchaseOrderId: input.purchaseOrderId,
        invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : new Date(),
        dueDate: input.dueDate,
        invoiceAmount: input.invoiceAmount,
        paymentTerms: input.paymentTerms,
        outstandingBalance: input.invoiceAmount,
        status: "OPEN",
        createdById: actor.id,
      },
      include: {
        supplier: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, poNumber: true } },
      },
    });

    return invoice;
  },

  async getById(id: string) {
    const invoice = await prisma.supplierInvoice.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, contactPerson: true, email: true, phone: true } },
        purchaseOrder: { select: { id: true, poNumber: true } },
        createdBy: { select: { id: true, name: true } },
        payments: {
          include: { recordedBy: { select: { id: true, name: true } } },
          orderBy: { paymentDate: "desc" },
        },
      },
    });

    if (!invoice) {
      throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
    }

    return invoice;
  },

  async update(id: string, input: UpdateSupplierInvoiceInput) {
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

    return prisma.supplierInvoice.update({
      where: { id },
      data: input,
    });
  },

  async recordPayment(invoiceId: string, input: RecordPaymentInput, actor: Pick<AuthenticatedUser, "id">) {
    await assertInvoiceOutstanding(invoiceId, input.amount);

    // Get supplierId from invoice for payment record
    const invoiceForSupplier = await prisma.supplierInvoice.findUnique({
      where: { id: invoiceId },
      select: { supplierId: true },
    });

    return prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          supplierInvoiceId: invoiceId,
          supplierId: invoiceForSupplier!.supplierId,
          amount: input.amount,
          paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
          notes: input.notes,
          recordedById: actor.id,
        },
        include: { recordedBy: { select: { id: true, name: true } } },
      });

      const invoice = await tx.supplierInvoice.findUnique({
        where: { id: invoiceId },
        select: { outstandingBalance: true, invoiceAmount: true },
      });

      const newOutstanding = invoice!.outstandingBalance.minus(input.amount);
      const newStatus = newOutstanding.lte(0) ? "PAID" : newOutstanding.lt(invoice!.invoiceAmount) ? "PARTIALLY_PAID" : "OPEN";

      await tx.supplierInvoice.update({
        where: { id: invoiceId },
        data: {
          outstandingBalance: newOutstanding,
          status: newStatus,
        },
      });

      return payment;
    });
  },

  async remove(id: string) {
    const invoice = await prisma.supplierInvoice.findUnique({
      where: { id },
      select: { id: true, status: true, _count: { select: { payments: true } } },
    });
    if (!invoice) {
      throw new AppError(404, ErrorCode.SUPPLIER_INVOICE_NOT_FOUND, "Invoice not found");
    }
    if (invoice._count.payments > 0) {
      throw new AppError(409, ErrorCode.BAD_REQUEST, "Cannot delete invoice with recorded payments");
    }

    await prisma.supplierInvoice.delete({ where: { id } });
  },
};