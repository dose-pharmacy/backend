import { Prisma } from "@prisma/client";
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

export type UpdateRequirementLineInput = Partial<{
  quantityNeeded: number;
  reasonCode: "LOW_STOCK" | "REORDER_ALERT" | "MANUAL";
  notes: string | null;
  status: "OPEN" | "ASSIGNED" | "CLOSED";
}>;

export type AssignSupplierToLineInput = {
  supplierId: string;
};

export type RequirementListQuery = PageQuery & {
  status?: "OPEN" | "ASSIGNED" | "CLOSED";
  search?: string;
};

export type RequirementLineWithRelations = {
  id: string;
  requirementId: string;
  productId: string;
  product: { id: string; name: string; sku: string };
  quantityNeeded: number;
  quantityDelivered: number;
  reasonCode: string | null;
  supplierId: string | null;
  supplier: { id: string; name: string } | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RequirementWithLines = {
  id: string;
  reference: string;
  status: string;
  requiredBy: Date | null;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lines: RequirementLineWithRelations[];
};

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

async function assertRequirementOpen(requirementId: string): Promise<void> {
  const req = await prisma.purchaseRequirement.findUnique({
    where: { id: requirementId },
    select: { status: true },
  });
  if (!req) {
    throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
  }
  if (req.status === "CLOSED") {
    throw new AppError(409, ErrorCode.REQUIREMENT_CLOSED, "Cannot modify a closed requirement");
  }
}

async function recomputeRequirementStatus(requirementId: string): Promise<void> {
  const lines = await prisma.purchaseRequirementLine.findMany({
    where: { requirementId },
    select: { status: true },
  });

  let newStatus: "OPEN" | "ASSIGNED" | "CLOSED";
  if (lines.every((l) => l.status === "CLOSED")) {
    newStatus = "CLOSED";
  } else if (lines.some((l) => l.status === "ASSIGNED")) {
    newStatus = "ASSIGNED";
  } else {
    newStatus = "OPEN";
  }

  await prisma.purchaseRequirement.update({
    where: { id: requirementId },
    data: { status: newStatus },
  });
}

function generatePRNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `PR-${timestamp}${random}`;
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
          lines: {
            include: {
              product: { select: { id: true, name: true, sku: true } },
              supplier: { select: { id: true, name: true } },
            },
          },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.purchaseRequirement.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateRequirementInput, actor: Pick<AuthenticatedUser, "id">) {
    // Validate products and check for duplicates within the requirement
    const productIds = input.lines.map((l) => l.productId);
    const uniqueProductIds = new Set(productIds);
    if (productIds.length !== uniqueProductIds.size) {
      throw new AppError(422, ErrorCode.DUPLICATE_PRODUCT_IN_REQUIREMENT, "Duplicate products in requirement");
    }

    for (const pid of productIds) {
      await assertProductExists(pid);
    }

    const reference = generatePRNumber();

    const requirement = await prisma.purchaseRequirement.create({
      data: {
        reference,
        requiredBy: input.requiredBy,
        notes: input.notes,
        createdById: actor.id,
        lines: {
          create: input.lines.map((line) => ({
            productId: line.productId,
            quantityNeeded: line.quantityNeeded,
            reasonCode: line.reasonCode,
            notes: line.notes,
            status: "OPEN",
          })),
        },
      },
      include: {
        lines: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            supplier: { select: { id: true, name: true } },
          },
        },
        createdBy: { select: { id: true, name: true } },
      },
    });

    return requirement;
  },

  async getById(id: string): Promise<RequirementWithLines> {
    const requirement = await prisma.purchaseRequirement.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            supplier: { select: { id: true, name: true } },
            purchaseOrderItems: {
              select: { id: true, purchaseOrderId: true, quantityOrdered: true },
            },
          },
        },
        createdBy: { select: { id: true, name: true } },
      },
    });

    if (!requirement) {
      throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
    }

    // Convert Decimal fields to numbers for API compatibility
    return {
      ...requirement,
      lines: requirement.lines.map((line) => ({
        ...line,
        quantityNeeded: line.quantityNeeded.toNumber(),
        quantityDelivered: line.quantityDelivered.toNumber(),
      })),
    };
  },

  async update(id: string, input: UpdateRequirementInput) {
    await assertRequirementOpen(id);

    return prisma.purchaseRequirement.update({
      where: { id },
      data: {
        requiredBy: input.requiredBy,
        notes: input.notes,
      },
      include: {
        lines: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    });
  },

  async addLine(requirementId: string, input: AddRequirementLineInput) {
    await assertRequirementOpen(requirementId);
    await assertProductExists(input.productId);

    // Check if product already exists in this requirement
    const existing = await prisma.purchaseRequirementLine.findUnique({
      where: { requirementId_productId: { requirementId, productId: input.productId } },
    });
    if (existing) {
      throw new AppError(409, ErrorCode.DUPLICATE_PRODUCT_IN_REQUIREMENT, "Product already exists in this requirement");
    }

    const line = await prisma.purchaseRequirementLine.create({
      data: {
        requirementId,
        productId: input.productId,
        quantityNeeded: input.quantityNeeded,
        reasonCode: input.reasonCode,
        notes: input.notes,
        status: "OPEN",
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    await recomputeRequirementStatus(requirementId);
    return line;
  },

  async updateLine(lineId: string, input: UpdateRequirementLineInput) {
    const line = await prisma.purchaseRequirementLine.findUnique({
      where: { id: lineId },
      select: { id: true, requirementId: true },
    });
    if (!line) {
      throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
    }

    await assertRequirementOpen(line.requirementId);

    const updated = await prisma.purchaseRequirementLine.update({
      where: { id: lineId },
      data: input,
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    await recomputeRequirementStatus(line.requirementId);
    return updated;
  },

  async assignSupplier(lineId: string, input: AssignSupplierToLineInput) {
    const line = await prisma.purchaseRequirementLine.findUnique({
      where: { id: lineId },
      select: { id: true, requirementId: true, supplierId: true },
    });
    if (!line) {
      throw new AppError(404, ErrorCode.REQUIREMENT_LINE_NOT_FOUND, "Requirement line not found");
    }

    await assertRequirementOpen(line.requirementId);

    // Verify supplier exists and is active
    const supplier = await prisma.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, isActive: true },
    });
    if (!supplier) {
      throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
    }
    if (!supplier.isActive) {
      throw new AppError(409, ErrorCode.INACTIVE_SUPPLIER, "Supplier is not active");
    }

    const updated = await prisma.purchaseRequirementLine.update({
      where: { id: lineId },
      data: {
        supplierId: input.supplierId,
        status: "ASSIGNED",
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    await recomputeRequirementStatus(line.requirementId);
    return updated;
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

    // Check if line has purchase order items
    const poItems = await prisma.purchaseOrderItem.count({
      where: { requirementLineId: lineId },
    });
    if (poItems > 0) {
      throw new AppError(409, ErrorCode.REQUIREMENT_LINE_HAS_PO, "Cannot remove line with associated purchase orders");
    }

    await prisma.purchaseRequirementLine.delete({ where: { id: lineId } });
    await recomputeRequirementStatus(line.requirementId);
  },

  async close(id: string) {
    const requirement = await prisma.purchaseRequirement.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!requirement) {
      throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
    }
    if (requirement.status === "CLOSED") {
      throw new AppError(409, ErrorCode.REQUIREMENT_CLOSED, "Requirement is already closed");
    }

    await prisma.purchaseRequirement.update({
      where: { id },
      data: { status: "CLOSED" },
    });

    // Close all lines
    await prisma.purchaseRequirementLine.updateMany({
      where: { requirementId: id },
      data: { status: "CLOSED" },
    });

    return this.getById(id);
  },

  async remove(id: string) {
    const requirement = await prisma.purchaseRequirement.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!requirement) {
      throw new AppError(404, ErrorCode.REQUIREMENT_NOT_FOUND, "Requirement not found");
    }

    // Check if any lines have purchase order items
    const lines = await prisma.purchaseRequirementLine.findMany({
      where: { requirementId: id },
      select: { id: true },
    });
    const lineIds = lines.map((l) => l.id);
    const poItems = await prisma.purchaseOrderItem.count({
      where: { requirementLineId: { in: lineIds } },
    });
    if (poItems > 0) {
      throw new AppError(409, ErrorCode.REQUIREMENT_LINE_HAS_PO, "Cannot delete requirement with associated purchase orders");
    }

    await prisma.purchaseRequirement.delete({ where: { id } });
  },

  async generateFromReorder(actor: Pick<AuthenticatedUser, "id">) {
    const { items } = await reorderService.getSuggestions({ page: 1, limit: 1000 });

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
            productId: item.productId,
            quantityNeeded: item.suggestedQuantity,
            reasonCode: "REORDER_ALERT",
            notes: `Suggested by reorder (${item.calculationMethod})`,
            status: "OPEN",
          })),
        },
      },
      include: {
        lines: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    });

    return requirement;
  },
};