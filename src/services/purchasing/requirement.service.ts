import { Prisma, PurchaseOrderStatus, PurchaseRequirementStatus } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { reorderService } from "../inventory/reorder.service.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreateRequirementInput = {
  requiredBy?: Date | null;
  notes?: string | null;
  lines: Array<{
    productId: string;
    quantityNeeded: number;
    reasonCode?: "LOW_STOCK" | "REORDER_ALERT" | "MANUAL";
    notes?: string | null;
  }>;
};

export type UpdateRequirementInput = Partial<{
  requiredBy: Date | null;
  notes: string | null;
}>;

export type AddRequirementLineInput = {
  productId: string;
  quantityNeeded: number;
  reasonCode?: "LOW_STOCK" | "REORDER_ALERT" | "MANUAL";
  notes?: string | null;
};

// Only fields that are genuinely editable are accepted. Fulfillment status and the
// derived ordered/remaining quantities are computed by the backend and can never be
// supplied by a client.
export type UpdateRequirementLineInput = Partial<{
  quantityNeeded: number;
  reasonCode: "LOW_STOCK" | "REORDER_ALERT" | "MANUAL";
  notes: string | null;
}>;

export type RequirementListQuery = PageQuery & {
  status?: PurchaseRequirementStatus;
  search?: string;
};

/** Prisma handle usable both inside and outside an interactive transaction. */
export type DbClient = Prisma.TransactionClient;

/**
 * A purchase order is only "active" for requirement accounting while it is not
 * cancelled. Received/closed orders still count as ordered — receiving must never
 * release a requirement allocation.
 */
const ACTIVE_ALLOCATION_WHERE = {
  purchaseOrderItem: {
    purchaseOrder: { status: { not: PurchaseOrderStatus.CANCELLED } },
  },
} satisfies Prisma.PurchaseRequirementAllocationWhereInput;

const ALLOCATION_INCLUDE = {
  purchaseOrderItem: {
    select: {
      id: true,
      purchaseOrderId: true,
      quantityOrdered: true,
      quantityReceived: true,
      unitCost: true,
      purchaseOrder: {
        select: {
          status: true,
          poNumber: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  },
} satisfies Prisma.PurchaseRequirementAllocationInclude;

type AllocationRow = {
  id: string;
  quantityAllocated: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
  purchaseOrderItem: {
    id: string;
    purchaseOrderId: string;
    quantityOrdered: Prisma.Decimal;
    quantityReceived: Prisma.Decimal;
    unitCost: Prisma.Decimal;
    purchaseOrder: {
      status: PurchaseOrderStatus;
      poNumber: string;
      supplier: { id: string; name: string } | null;
    };
  };
};

type LineRow = {
  id: string;
  requirementId: string;
  productId: string;
  product: { id: string; name: string; sku: string };
  quantityNeeded: Prisma.Decimal;
  quantityDelivered: Prisma.Decimal;
  reasonCode: string | null;
  status: PurchaseRequirementStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  allocations: AllocationRow[];
};

export type RequirementAllocationView = {
  id: string;
  quantityAllocated: number;
  active: boolean;
  purchaseOrderItemId: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  purchaseOrderStatus: PurchaseOrderStatus;
  supplier: { id: string; name: string } | null;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RequirementLineView = {
  id: string;
  requirementId: string;
  productId: string;
  product: { id: string; name: string; sku: string };
  requiredQuantity: number;
  // Backwards-compatible aliases for the pre-existing response shape.
  quantityNeeded: number;
  quantityOrdered: number;
  orderedQuantity: number;
  quantityRemaining: number;
  remainingQuantity: number;
  remainingToOrder: number;
  quantityDelivered: number;
  remainingToReceive: number;
  activeOrderCount: number;
  reasonCode: string | null;
  status: PurchaseRequirementStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  allocations: RequirementAllocationView[];
};

export type RequirementWithLines = {
  id: string;
  reference: string;
  status: PurchaseRequirementStatus;
  requiredBy: Date | null;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lines: RequirementLineView[];
};

function deriveLineStatus(
  required: number,
  ordered: number,
  storedStatus: PurchaseRequirementStatus,
): PurchaseRequirementStatus {
  if (storedStatus === PurchaseRequirementStatus.CLOSED) {
    return PurchaseRequirementStatus.CLOSED;
  }
  if (ordered <= 0) {
    return PurchaseRequirementStatus.OPEN;
  }
  if (ordered < required) {
    return PurchaseRequirementStatus.PARTIALLY_FULFILLED;
  }
  return PurchaseRequirementStatus.FULFILLED;
}

function mapAllocation(allocation: AllocationRow): RequirementAllocationView {
  const item = allocation.purchaseOrderItem;
  return {
    id: allocation.id,
    quantityAllocated: allocation.quantityAllocated.toNumber(),
    active: item.purchaseOrder.status !== PurchaseOrderStatus.CANCELLED,
    purchaseOrderItemId: item.id,
    purchaseOrderId: item.purchaseOrderId,
    purchaseOrderNumber: item.purchaseOrder.poNumber,
    purchaseOrderStatus: item.purchaseOrder.status,
    supplier: item.purchaseOrder.supplier,
    quantityOrdered: item.quantityOrdered.toNumber(),
    quantityReceived: item.quantityReceived.toNumber(),
    unitCost: item.unitCost.toNumber(),
    createdAt: allocation.createdAt,
    updatedAt: allocation.updatedAt,
  };
}

/**
 * Maps a requirement line to a client-friendly shape. `orderedQuantity` and
 * `remainingQuantity` are derived from active allocations — never from persisted
 * client-supplied values.
 */
function mapRequirementLine(line: LineRow): RequirementLineView {
  const required = line.quantityNeeded.toNumber();
  const ordered = line.allocations
    .filter((a) => a.purchaseOrderItem.purchaseOrder.status !== PurchaseOrderStatus.CANCELLED)
    .reduce((sum, a) => sum + a.quantityAllocated.toNumber(), 0);
  const delivered = line.quantityDelivered.toNumber();
  const remainingQuantity = Math.max(0, required - ordered);
  const activeOrderCount = line.allocations.filter(
    (a) => a.purchaseOrderItem.purchaseOrder.status !== PurchaseOrderStatus.CANCELLED,
  ).length;

  return {
    id: line.id,
    requirementId: line.requirementId,
    productId: line.productId,
    product: line.product,
    requiredQuantity: required,
    quantityNeeded: required,
    quantityOrdered: ordered,
    orderedQuantity: ordered,
    quantityRemaining: remainingQuantity,
    remainingQuantity,
    remainingToOrder: remainingQuantity,
    quantityDelivered: delivered,
    remainingToReceive: Math.max(0, ordered - delivered),
    activeOrderCount,
    reasonCode: line.reasonCode,
    status: deriveLineStatus(required, ordered, line.status),
    notes: line.notes,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
    allocations: line.allocations.map(mapAllocation),
  };
}

async function assertProductExists(productId: string): Promise<void> {
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

async function assertRequirementOpen(
  requirementId: string,
  db: DbClient = prisma,
): Promise<void> {
  const req = await db.purchaseRequirement.findUnique({
    where: { id: requirementId },
    select: { status: true },
  });
  if (!req) {
    throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
  }
  if (req.status === PurchaseRequirementStatus.CLOSED) {
    throw new AppError(409, ErrorCode.REQUIREMENT_CLOSED, "Cannot modify a closed requirement");
  }
}

/** Sum of allocations for a line that belong to a non-cancelled purchase order. */
export async function activeAllocatedForLine(
  lineId: string,
  db: DbClient = prisma,
): Promise<number> {
  const aggregate = await db.purchaseRequirementAllocation.aggregate({
    where: { requirementLineId: lineId, ...ACTIVE_ALLOCATION_WHERE },
    _sum: { quantityAllocated: true },
  });
  return aggregate._sum.quantityAllocated?.toNumber() ?? 0;
}

/**
 * Recomputes the stored status of every line in a requirement (and the requirement
 * header) from active allocations. Runs inside the caller's transaction when one is
 * supplied so it stays consistent with the allocation write that triggered it.
 */
export async function recomputeRequirementStatus(
  requirementId: string,
  db: DbClient = prisma,
): Promise<void> {
  const lines = await db.purchaseRequirementLine.findMany({
    where: { requirementId },
    select: { id: true, status: true, quantityNeeded: true },
  });

  if (lines.length === 0) {
    await db.purchaseRequirement.update({
      where: { id: requirementId },
      data: { status: PurchaseRequirementStatus.OPEN },
    });
    return;
  }

  const sums = await db.purchaseRequirementAllocation.groupBy({
    by: ["requirementLineId"],
    where: {
      requirementLineId: { in: lines.map((l) => l.id) },
      ...ACTIVE_ALLOCATION_WHERE,
    },
    _sum: { quantityAllocated: true },
  });
  const allocatedByLine = new Map<string, number>(
    sums.map((s) => [s.requirementLineId, s._sum.quantityAllocated?.toNumber() ?? 0]),
  );

  const evaluated = lines.map((line) => {
    const required = line.quantityNeeded.toNumber();
    const allocated = allocatedByLine.get(line.id) ?? 0;
    return {
      id: line.id,
      closed: line.status === PurchaseRequirementStatus.CLOSED,
      storedStatus: line.status,
      required,
      allocated,
      derived: deriveLineStatus(required, allocated, line.status),
    };
  });

  for (const line of evaluated) {
    if (line.derived !== line.storedStatus) {
      await db.purchaseRequirementLine.update({
        where: { id: line.id },
        data: { status: line.derived },
      });
    }
  }

  const nonClosed = evaluated.filter((l) => !l.closed);
  let headerStatus: PurchaseRequirementStatus;
  if (nonClosed.length === 0) {
    headerStatus = PurchaseRequirementStatus.CLOSED;
  } else {
    const anyShort = nonClosed.some((l) => l.allocated < l.required);
    const anyOrdered = nonClosed.some((l) => l.allocated > 0);
    headerStatus = !anyShort
      ? PurchaseRequirementStatus.FULFILLED
      : anyOrdered
        ? PurchaseRequirementStatus.PARTIALLY_FULFILLED
        : PurchaseRequirementStatus.OPEN;
  }

  await db.purchaseRequirement.update({
    where: { id: requirementId },
    data: { status: headerStatus },
  });
}

function generatePRNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `PR-${timestamp}${random}`;
}

const LINE_INCLUDE_ACTIVE = {
  product: { select: { id: true, name: true, sku: true } },
  allocations: {
    where: ACTIVE_ALLOCATION_WHERE,
    include: ALLOCATION_INCLUDE,
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.PurchaseRequirementLineInclude;

// Detail view keeps cancelled allocations for auditability; the mapper still excludes
// them from the derived ordered quantity.
const LINE_INCLUDE_ALL = {
  product: { select: { id: true, name: true, sku: true } },
  allocations: {
    include: ALLOCATION_INCLUDE,
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.PurchaseRequirementLineInclude;

async function loadMappingLine(lineId: string): Promise<LineRow> {
  const line = await prisma.purchaseRequirementLine.findUnique({
    where: { id: lineId },
    include: LINE_INCLUDE_ACTIVE,
  });
  if (!line) {
    throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
  }
  return line as unknown as LineRow;
}

export const requirementService = {
  async list(query: RequirementListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.PurchaseRequirementWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { reference: { contains: query.search, mode: "insensitive" as const } },
              { notes: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.purchaseRequirement.findMany({
        where,
        include: {
          lines: { include: LINE_INCLUDE_ACTIVE },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.purchaseRequirement.count({ where }),
    ]);

    const mappedItems = items.map((req) => ({
      ...req,
      lines: (req.lines as unknown as LineRow[]).map(mapRequirementLine),
    }));

    return { items: mappedItems, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateRequirementInput, actor: Pick<AuthenticatedUser, "id">) {
    const productIds = input.lines.map((l) => l.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new AppError(
        422,
        ErrorCode.DUPLICATE_PRODUCT_IN_REQUIREMENT,
        "Duplicate products in requirement",
      );
    }

    for (const pid of productIds) {
      await assertProductExists(pid);
    }

    const requirement = await prisma.purchaseRequirement.create({
      data: {
        reference: generatePRNumber(),
        requiredBy: input.requiredBy,
        notes: input.notes,
        createdById: actor.id,
        lines: {
          create: input.lines.map((line) => ({
            productId: line.productId,
            quantityNeeded: line.quantityNeeded,
            reasonCode: line.reasonCode,
            notes: line.notes,
            status: PurchaseRequirementStatus.OPEN,
          })),
        },
      },
      include: {
        lines: { include: LINE_INCLUDE_ACTIVE },
        createdBy: { select: { id: true, name: true } },
      },
    });

    return {
      ...requirement,
      lines: (requirement.lines as unknown as LineRow[]).map(mapRequirementLine),
    };
  },

  async getById(id: string): Promise<RequirementWithLines> {
    const requirement = await prisma.purchaseRequirement.findUnique({
      where: { id },
      include: {
        lines: { include: LINE_INCLUDE_ALL },
        createdBy: { select: { id: true, name: true } },
      },
    });

    if (!requirement) {
      throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
    }

    return {
      ...requirement,
      lines: (requirement.lines as unknown as LineRow[]).map(mapRequirementLine),
    };
  },

  /**
   * Prefill payload for the frontend to open a purchase order from a requirement
   * item. Read-only: the client is told exactly how much is still available and must
   * not compute it itself.
   */
  async getOrderPreview(lineId: string) {
    const line = await prisma.purchaseRequirementLine.findUnique({
      where: { id: lineId },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        requirement: {
          select: { id: true, reference: true, status: true, requiredBy: true },
        },
      },
    });
    if (!line) {
      throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
    }

    const required = line.quantityNeeded.toNumber();
    const ordered = await activeAllocatedForLine(lineId);
    const remaining = Math.max(0, required - ordered);
    const activeOrderCount = await prisma.purchaseRequirementAllocation.count({
      where: { requirementLineId: lineId, ...ACTIVE_ALLOCATION_WHERE },
    });

    return {
      requirementLineId: line.id,
      requirementId: line.requirementId,
      requirementReference: line.requirement.reference,
      requirementStatus: line.requirement.status,
      requiredBy: line.requirement.requiredBy,
      product: line.product,
      requiredQuantity: required,
      orderedQuantity: ordered,
      remainingQuantity: remaining,
      suggestedOrderQuantity: remaining,
      activeOrderCount,
      lineStatus: deriveLineStatus(required, ordered, line.status),
    };
  },

  async update(id: string, input: UpdateRequirementInput) {
    await assertRequirementOpen(id);

    const updatedReq = await prisma.purchaseRequirement.update({
      where: { id },
      data: {
        requiredBy: input.requiredBy,
        notes: input.notes,
      },
      include: { lines: { include: LINE_INCLUDE_ACTIVE } },
    });

    return {
      ...updatedReq,
      lines: (updatedReq.lines as unknown as LineRow[]).map(mapRequirementLine),
    };
  },

  async addLine(requirementId: string, input: AddRequirementLineInput) {
    await assertRequirementOpen(requirementId);
    await assertProductExists(input.productId);

    const existing = await prisma.purchaseRequirementLine.findUnique({
      where: { requirementId_productId: { requirementId, productId: input.productId } },
    });
    if (existing) {
      throw new AppError(
        409,
        ErrorCode.DUPLICATE_PRODUCT_IN_REQUIREMENT,
        "Product already exists in this requirement",
      );
    }

    const line = await prisma.purchaseRequirementLine.create({
      data: {
        requirementId,
        productId: input.productId,
        quantityNeeded: input.quantityNeeded,
        reasonCode: input.reasonCode,
        notes: input.notes,
        status: PurchaseRequirementStatus.OPEN,
      },
      include: LINE_INCLUDE_ACTIVE,
    });

    await recomputeRequirementStatus(requirementId);

    return mapRequirementLine(line as unknown as LineRow);
  },

  async updateLine(lineId: string, input: UpdateRequirementLineInput) {
    const line = await prisma.purchaseRequirementLine.findUnique({
      where: { id: lineId },
      select: { id: true, requirementId: true, quantityNeeded: true, status: true },
    });
    if (!line) {
      throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
    }

    await assertRequirementOpen(line.requirementId);

    const data: Prisma.PurchaseRequirementLineUpdateInput = {};
    if (input.reasonCode !== undefined) data.reasonCode = input.reasonCode;
    if (input.notes !== undefined) data.notes = input.notes;

    if (input.quantityNeeded !== undefined) {
      const alreadyOrdered = await activeAllocatedForLine(lineId);
      if (input.quantityNeeded < alreadyOrdered) {
        throw new AppError(
          409,
          ErrorCode.REQUIREMENT_QUANTITY_BELOW_ORDERED,
          "Cannot reduce the required quantity below what has already been ordered",
          {
            requiredQuantity: input.quantityNeeded,
            currentlyOrderedQuantity: alreadyOrdered,
            remainingQuantity: Math.max(0, input.quantityNeeded - alreadyOrdered),
          },
        );
      }
      data.quantityNeeded = input.quantityNeeded;
    }

    const updated = await prisma.purchaseRequirementLine.update({
      where: { id: lineId },
      data,
      include: LINE_INCLUDE_ACTIVE,
    });

    await recomputeRequirementStatus(line.requirementId);

    return mapRequirementLine(updated as unknown as LineRow);
  },

  async removeLine(lineId: string) {
    const line = await prisma.purchaseRequirementLine.findUnique({
      where: { id: lineId },
      select: { id: true, requirementId: true },
    });
    if (!line) {
      throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
    }

    await assertRequirementOpen(line.requirementId);

    const activeAllocations = await prisma.purchaseRequirementAllocation.count({
      where: { requirementLineId: lineId, ...ACTIVE_ALLOCATION_WHERE },
    });
    // Legacy/direct PO items (created before allocations existed) must also block.
    const directItems = await prisma.purchaseOrderItem.count({
      where: {
        requirementLineId: lineId,
        purchaseOrder: { status: { not: PurchaseOrderStatus.CANCELLED } },
      },
    });
    if (activeAllocations > 0 || directItems > 0) {
      throw new AppError(
        409,
        ErrorCode.REQUIREMENT_HAS_ACTIVE_ORDERS,
        "Cannot remove a requirement line that has active purchase orders",
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.purchaseRequirementLine.delete({ where: { id: lineId } });
      await recomputeRequirementStatus(line.requirementId, tx);
    });
  },

  async close(id: string) {
    const requirement = await prisma.purchaseRequirement.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!requirement) {
      throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
    }
    if (requirement.status === PurchaseRequirementStatus.CLOSED) {
      throw new AppError(409, ErrorCode.REQUIREMENT_CLOSED, "Requirement is already closed");
    }

    // Pending purchase orders must be resolved first, but a requirement whose orders
    // have all been received/closed/cancelled may be finalised.
    const pending = await prisma.purchaseRequirementAllocation.count({
      where: {
        requirementLine: { requirementId: id },
        purchaseOrderItem: {
          purchaseOrder: {
            status: {
              in: [PurchaseOrderStatus.REGISTERED, PurchaseOrderStatus.AWAITING_DELIVERY],
            },
          },
        },
      },
    });
    if (pending > 0) {
      throw new AppError(
        409,
        ErrorCode.REQUIREMENT_HAS_ACTIVE_ORDERS,
        "Cannot close a requirement while purchase orders are still pending. Cancel or receive them first.",
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.purchaseRequirement.update({
        where: { id },
        data: { status: PurchaseRequirementStatus.CLOSED },
      });
      await tx.purchaseRequirementLine.updateMany({
        where: { requirementId: id },
        data: { status: PurchaseRequirementStatus.CLOSED },
      });
    });

    return this.getById(id);
  },

  async remove(id: string) {
    const requirement = await prisma.purchaseRequirement.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!requirement) {
      throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
    }

    const lines = await prisma.purchaseRequirementLine.findMany({
      where: { requirementId: id },
      select: { id: true },
    });
    const lineIds = lines.map((l) => l.id);

    const activeAllocations = await prisma.purchaseRequirementAllocation.count({
      where: { requirementLineId: { in: lineIds }, ...ACTIVE_ALLOCATION_WHERE },
    });
    const directItems = await prisma.purchaseOrderItem.count({
      where: {
        requirementLineId: { in: lineIds },
        purchaseOrder: { status: { not: PurchaseOrderStatus.CANCELLED } },
      },
    });
    if (activeAllocations > 0 || directItems > 0) {
      throw new AppError(
        409,
        ErrorCode.REQUIREMENT_HAS_ACTIVE_ORDERS,
        "Cannot delete a requirement that still has active purchase orders",
      );
    }

    await prisma.purchaseRequirement.delete({ where: { id } });
  },

  async generateFromReorder(actor: Pick<AuthenticatedUser, "id">) {
    const { items } = await reorderService.getSuggestions({ page: 1, limit: 100 });

    if (items.length === 0) {
      throw new AppError(409, ErrorCode.BAD_REQUEST, "No reorder suggestions available");
    }

    const requirement = await prisma.purchaseRequirement.create({
      data: {
        reference: generatePRNumber(),
        notes: "Auto-generated from reorder suggestions",
        createdById: actor.id,
        lines: {
          create: items.map((item) => ({
            productId: item.product.id,
            quantityNeeded: item.suggestedQuantity,
            reasonCode: "REORDER_ALERT" as const,
            notes: `Suggested by reorder (${item.calculationMethod})`,
            status: PurchaseRequirementStatus.OPEN,
          })),
        },
      },
      include: {
        lines: { include: LINE_INCLUDE_ACTIVE },
        createdBy: { select: { id: true, name: true } },
      },
    });

    return {
      ...requirement,
      lines: (requirement.lines as unknown as LineRow[]).map(mapRequirementLine),
    };
  },
};

// Re-exported so callers can obtain a freshly mapped line after an external mutation
// (e.g. purchase order item edits) without duplicating the mapper.
export { loadMappingLine, mapRequirementLine };
