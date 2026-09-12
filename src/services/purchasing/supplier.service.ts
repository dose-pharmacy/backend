import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateSupplierInput = {
  name: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  paymentTerms?: string | null;
  isActive?: boolean;
};

export type UpdateSupplierInput = Partial<CreateSupplierInput>;

export type SupplierListQuery = PageQuery & {
  search?: string;
  isActive?: boolean;
};

export type SupplierSummary = {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  paymentTerms: string | null;
  isActive: boolean;
  _count: {
    purchaseOrders: number;
    supplierInvoices: number;
    purchaseReturns: number;
  };
  totalOutstanding: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SupplierDetail = SupplierSummary & {
  purchaseOrders: Array<{
    id: string;
    poNumber: string;
    status: string;
    orderDate: Date;
    expectedDeliveryDate: Date | null;
  }>;
  supplierInvoices: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    invoiceAmount: number;
    outstandingBalance: number;
  }>;
};

function _generateReference(prefix: string): string {
  const count = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `${prefix}-${count}`;
}

async function assertSupplierExists(id: string): Promise<void> {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!supplier) {
    throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
  }
}

async function _assertSupplierActive(id: string): Promise<void> {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!supplier) {
    throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
  }
  if (!supplier.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_SUPPLIER, "Supplier is not active");
  }
}

export const supplierService = {
  async list(query: SupplierListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.SupplierWhereInput = {
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              { contactPerson: { contains: query.search, mode: "insensitive" as const } },
              { email: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.supplier.findMany({
        where,
        select: {
          id: true,
          name: true,
          contactPerson: true,
          email: true,
          phone: true,
          address: true,
          paymentTerms: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              purchaseOrders: true,
              supplierInvoices: true,
              purchaseReturns: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.supplier.count({ where }),
    ]);

    const results: SupplierSummary[] = items.map((s) => ({
      ...s,
      totalOutstanding: 0, // computed separately if needed
    }));

    return { items: results, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateSupplierInput) {
    const existing = await prisma.supplier.findFirst({
      where: { name: { equals: input.name, mode: "insensitive" as const } },
    });
    if (existing) {
      throw new AppError(409, ErrorCode.DUPLICATE_SUPPLIER, "A supplier with this name already exists");
    }

    return prisma.supplier.create({
      data: {
        name: input.name,
        contactPerson: input.contactPerson,
        email: input.email,
        phone: input.phone,
        address: input.address,
        paymentTerms: input.paymentTerms,
        isActive: input.isActive ?? true,
      },
    });
  },

  async getById(id: string): Promise<SupplierDetail> {
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        purchaseOrders: {
          select: {
            id: true,
            poNumber: true,
            status: true,
            orderDate: true,
            expectedDeliveryDate: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        supplierInvoices: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            invoiceAmount: true,
            outstandingBalance: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });

    if (!supplier) {
      throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
    }

    // Calculate total outstanding balance and counts
    const [invoices, poCount, siCount, prCount] = await Promise.all([
      prisma.supplierInvoice.findMany({
        where: { supplierId: id, status: { in: ["OPEN", "PARTIALLY_PAID"] } },
        select: { outstandingBalance: true },
      }),
      prisma.purchaseOrder.count({ where: { supplierId: id } }),
      prisma.supplierInvoice.count({ where: { supplierId: id } }),
      prisma.purchaseReturn.count({ where: { supplierId: id } }),
    ]);
    const totalOutstanding = invoices.reduce((sum: number, inv: { outstandingBalance: { toNumber: () => number } }) => sum + inv.outstandingBalance.toNumber(), 0);

    // Convert Decimal fields to numbers for API
    const convertedSupplier = {
      ...supplier,
      purchaseOrders: supplier.purchaseOrders.map((po) => ({
        ...po,
        status: po.status,
      })),
      supplierInvoices: supplier.supplierInvoices.map((inv) => ({
        ...inv,
        invoiceAmount: inv.invoiceAmount.toNumber(),
        outstandingBalance: inv.outstandingBalance.toNumber(),
      })),
    };

    return {
      ...convertedSupplier,
      _count: {
        purchaseOrders: poCount,
        supplierInvoices: siCount,
        purchaseReturns: prCount,
      },
      totalOutstanding,
    };
  },

  async update(id: string, input: UpdateSupplierInput) {
    await assertSupplierExists(id);

    if (input.name !== undefined) {
      const existing = await prisma.supplier.findFirst({
        where: {
          name: { equals: input.name, mode: "insensitive" as const },
          id: { not: id },
        },
      });
      if (existing) {
        throw new AppError(409, ErrorCode.DUPLICATE_SUPPLIER, "A supplier with this name already exists");
      }
    }

    return prisma.supplier.update({
      where: { id },
      data: input,
    });
  },

  async remove(id: string) {
    await assertSupplierExists(id);

    const usages = await prisma.$transaction([
      prisma.purchaseOrder.count({ where: { supplierId: id } }),
      prisma.supplierInvoice.count({ where: { supplierId: id } }),
      prisma.purchaseReturn.count({ where: { supplierId: id } }),
      prisma.purchaseRequirementLine.count({ where: { supplierId: id } }),
      prisma.expiryAction.count({ where: { supplierId: id } }),
      prisma.batch.count({ where: { supplierId: id } }),
    ]);

    const totalUsages = usages.reduce((sum, count) => sum + count, 0);
    if (totalUsages > 0) {
      throw new AppError(
        409,
        ErrorCode.SUPPLIER_IN_USE,
        "Cannot delete supplier with associated records",
        {
          purchaseOrders: usages[0],
          supplierInvoices: usages[1],
          purchaseReturns: usages[2],
          requirementLines: usages[3],
          expiryActions: usages[4],
          batches: usages[5],
        }
      );
    }

    await prisma.supplier.delete({ where: { id } });
  },
};