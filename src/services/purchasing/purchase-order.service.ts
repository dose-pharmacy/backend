import { Prisma, PurchaseOrderStatus, PurchaseRequirementStatus } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { recomputeRequirementStatus } from "./requirement.service.js";
import type { DbClient } from "./requirement.service.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreatePOItemInput = {
  productId: string;
  quantityOrdered: number;
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
  search?: string;
};

/** Internal shape where a requirement-linked item may omit (and derive) its product. */
type ResolvedItemInput = {
  productId?: string;
  quantityOrdered: number;
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

async function sumActiveAllocations(tx: Prisma.TransactionClient, lineId: string): Promise<number> {
  const aggregate = await tx.purchaseRequirementAllocation.aggregate({
    where: {
      requirementLineId: lineId,
      purchaseOrderItem: { purchaseOrder: { status: { not: PurchaseOrderStatus.CANCELLED } } },
    },
    _sum: { quantityAllocated: true },
  });
  return aggregate._sum.quantityAllocated?.toNumber() ?? 0;
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
          status: true,
        },
      })
    : [];
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const productIds = new Set<string>();
  const resolvedItems: Array<{
    productId: string;
    quantityOrdered: number;
    unitCost: number;
    requirementLineId: string | null;
  }> = [];
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

      const required = line.quantityNeeded.toNumber();
      const alreadyAllocated = await sumActiveAllocations(tx, line.id);
      const reserved = reservedByLine.get(line.id) ?? 0;
      const available = required - alreadyAllocated - reserved;
      if (item.quantityOrdered > available) {
        throw new AppError(
          409,
          ErrorCode.REQUIREMENT_QUANTITY_EXCEEDED,
          "Requested quantity exceeds the remaining quantity on the requirement line",
          {
            requiredQuantity: required,
            currentlyOrderedQuantity: alreadyAllocated + reserved,
            remainingQuantity: Math.max(0, available),
            requestedQuantity: item.quantityOrdered,
          },
        );
      }

      reservedByLine.set(line.id, reserved + item.quantityOrdered);
      productIds.add(line.productId);
      resolvedItems.push({
        productId: line.productId,
        quantityOrdered: item.quantityOrdered,
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
      resolvedItems.push({
        productId: item.productId,
        quantityOrdered: item.quantityOrdered,
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
          quantityAllocated: item.quantityOrdered,
        },
      });
    }
  }

  for (const requirementId of new Set(lines.map((l) => l.requirementId))) {
    await recomputeRequirementStatus(requirementId, tx);
  }

  return tx.purchaseOrder.findUnique({
    where: { id: po.id },
    include: PO_DETAIL_INCLUDE,
  });
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
    if (po.status === PurchaseOrderStatus.CANCELLED || po.status === PurchaseOrderStatus.CLOSED) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Cannot modify a cancelled or closed order",
      );
    }

    return prisma.purchaseOrder.update({
      where: { id },
      data: {
        expectedDeliveryDate: input.expectedDeliveryDate,
        notes: input.notes,
      },
      include: PO_DETAIL_INCLUDE,
    });
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
            select: { id: true, requirementId: true, quantityNeeded: true },
          });
          if (!line) {
            throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
          }
          requirementId = line.requirementId;

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
          const required = line.quantityNeeded.toNumber();
          const maxAllowed = required - otherAllocated;
          if (input.quantityOrdered > maxAllowed) {
            throw new AppError(
              409,
              ErrorCode.REQUIREMENT_QUANTITY_EXCEEDED,
              "Requested quantity exceeds the remaining quantity on the requirement line",
              {
                requiredQuantity: required,
                currentlyOrderedQuantity: otherAllocated,
                remainingQuantity: Math.max(0, maxAllowed),
                requestedQuantity: input.quantityOrdered,
              },
            );
          }

          await tx.purchaseRequirementAllocation.update({
            where: { id: allocation.id },
            data: { quantityAllocated: input.quantityOrdered },
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

      return tx.purchaseOrder.findUnique({ where: { id }, include: PO_DETAIL_INCLUDE });
    }, TX_OPTIONS);
  },

  async markAwaitingDelivery(id: string) {
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

    return prisma.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.AWAITING_DELIVERY },
      include: PO_DETAIL_INCLUDE,
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
    if (po.status !== PurchaseOrderStatus.RECEIVED) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Only received orders can be closed",
      );
    }

    const incomplete = po.items.some((i) => i.quantityReceived.lessThan(i.quantityOrdered));
    if (incomplete) {
      throw new AppError(
        409,
        ErrorCode.PO_STATUS_TRANSITION_INVALID,
        "Cannot close order with partially received items",
      );
    }

    return prisma.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.CLOSED },
      include: PO_DETAIL_INCLUDE,
    });
  },
};
