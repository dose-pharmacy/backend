import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreatePOInput = {
  supplierId: string;
  expectedDeliveryDate?: Date | null;
  notes?: string | null;
  items: Array<{
    productId: string;
    quantityOrdered: number;
    unitCost: number;
    requirementLineId?: string | null;
  }>;
};

export type UpdatePOInput = Partial<{
  expectedDeliveryDate: Date | null;
  notes: string | null;
}>;

export type POListQuery = PageQuery & {
  supplierId?: string;
  status?: "REGISTERED" | "AWAITING_DELIVERY" | "RECEIVED" | "CLOSED" | "CANCELLED";
  search?: string;
};

function generatePONumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `PO-${timestamp}${random}`;
}

async function assertSupplierActive(supplierId: string): Promise<void> {
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

async function assertProductActive(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
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

async function assertRequirementLine(lineId: string): Promise<{ id: string; requirementId: string; quantityNeeded: number; status: string }> {
  const line = await prisma.purchaseRequirementLine.findUnique({
    where: { id: lineId },
    select: { id: true, requirementId: true, quantityNeeded: true, status: true },
  });
  if (!line) {
    throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
  }
  if (line.status === "CLOSED") {
    throw new AppError(409, ErrorCode.REQUIREMENT_CLOSED, "Requirement line is already closed");
  }
  return { ...line, quantityNeeded: Number(line.quantityNeeded) };
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

    const [items, total] = await prisma.$transaction([
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
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreatePOInput, actor: Pick<AuthenticatedUser, "id">) {
    await assertSupplierActive(input.supplierId);

    // Validate all products
    const productIds = input.items.map((i) => i.productId);
    for (const pid of productIds) {
      await assertProductActive(pid);
    }

    // Validate requirement lines and check for over-ordering
    for (const item of input.items) {
      if (item.requirementLineId) {
        const reqLine = await assertRequirementLine(item.requirementLineId);

        // Sum already-ordered quantities (excluding cancelled POs) within a serialisable check
        const existingOrdered = await prisma.purchaseOrderItem.aggregate({
          where: {
            requirementLineId: item.requirementLineId,
            purchaseOrder: { status: { notIn: ["CANCELLED"] } },
          },
          _sum: { quantityOrdered: true },
        });
        const alreadyOrdered = existingOrdered._sum.quantityOrdered?.toNumber() ?? 0;
        const newTotal = alreadyOrdered + item.quantityOrdered;
        if (newTotal > reqLine.quantityNeeded) {
          throw new AppError(
            422,
            ErrorCode.PO_OVER_ORDER,
            `Over-ordering: need ${reqLine.quantityNeeded}, already ordered ${alreadyOrdered}, cannot add ${item.quantityOrdered} more`
          );
        }
      }
    }

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: generatePONumber(),
        supplierId: input.supplierId,
        expectedDeliveryDate: input.expectedDeliveryDate,
        notes: input.notes,
        status: "REGISTERED",
        createdById: actor.id,
        items: {
          create: input.items.map((item) => ({
            productId: item.productId,
            quantityOrdered: item.quantityOrdered,
            unitCost: item.unitCost,
            requirementLineId: item.requirementLineId,
          })),
        },
      },
      include: {
        supplier: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            requirementLine: {
              select: { id: true, quantityNeeded: true, quantityDelivered: true },
            },
          },
        },
      },
    });

    return po;
  },

  async getById(id: string) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, contactPerson: true, email: true, phone: true } },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            requirementLine: {
              select: { id: true, quantityNeeded: true, quantityDelivered: true },
            },
          },
        },
        goodsReceipts: {
          select: {
            id: true,
            receiptNumber: true,
            status: true,
            receivedDate: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }

    return po;
  },

  async update(id: string, input: UpdatePOInput) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status === "CANCELLED" || po.status === "CLOSED") {
      throw new AppError(409, ErrorCode.PO_STATUS_TRANSITION_INVALID, "Cannot modify a cancelled or closed order");
    }

    return prisma.purchaseOrder.update({
      where: { id },
      data: {
        expectedDeliveryDate: input.expectedDeliveryDate,
        notes: input.notes,
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
          },
        },
      },
    });
  },

  async cancel(id: string, _actor: Pick<AuthenticatedUser, "id">) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status === "RECEIVED" || po.status === "CLOSED" || po.status === "CANCELLED") {
      throw new AppError(409, ErrorCode.PO_CANNOT_CANCEL, "Cannot cancel an order that has been received or closed");
    }

    await prisma.purchaseOrder.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return this.getById(id);
  },

  async markAwaitingDelivery(id: string) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status !== "REGISTERED") {
      throw new AppError(409, ErrorCode.PO_STATUS_TRANSITION_INVALID, "Only registered orders can be marked as awaiting delivery");
    }

    return prisma.purchaseOrder.update({
      where: { id },
      data: { status: "AWAITING_DELIVERY" },
    });
  },

  async close(id: string) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: { select: { id: true, quantityOrdered: true, quantityReceived: true } },
      },
    });
    if (!po) {
      throw new AppError(404, ErrorCode.PURCHASE_ORDER_NOT_FOUND, "Purchase order not found");
    }
    if (po.status !== "RECEIVED") {
      throw new AppError(409, ErrorCode.PO_STATUS_TRANSITION_INVALID, "Only received orders can be closed");
    }
    // Verify all items fully received
    const incomplete = po.items.some((i) => i.quantityReceived.lessThan(i.quantityOrdered));
    if (incomplete) {
      throw new AppError(409, ErrorCode.PO_STATUS_TRANSITION_INVALID, "Cannot close order with partially received items");
    }

    return prisma.purchaseOrder.update({
      where: { id },
      data: { status: "CLOSED" },
    });
  },
};