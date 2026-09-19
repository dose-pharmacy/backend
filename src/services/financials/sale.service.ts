import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { stockMovementService } from "../inventory/stock-movement.service.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { discountAuthRuleService } from "./discount-auth-rule.service.js";
import type { PageQuery } from "../../utils/pagination.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type CreateSaleInput = {
  locationId: string;
  lines: Array<{
    productId: string;
    unitSold: string;
    quantity: number;
    quantityBaseUnits: number;
    unitPrice: number;
    itemDiscountAmount?: number;
  }>;
  billDiscountAmount?: number;
  payments: Array<{
    method: "CASH" | "CARD" | "DIGITAL_TRANSFER";
    amount: number;
    reference?: string | null;
  }>;
};

export type UpdateSaleInput = Partial<{
  voidReason: string | null;
  status: "COMPLETED" | "CANCELLED";
}>;

export type SaleListQuery = PageQuery & {
  status?: "COMPLETED" | "CANCELLED";
  locationId?: string;
  cashierId?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

function generateSaleNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `SAL-${timestamp}${random}`;
}

async function assertLocationActive(locationId: string) {
  const location = await prisma.inventoryLocation.findUnique({
    where: { id: locationId },
    select: { id: true, isActive: true },
  });
  if (!location) {
    throw new AppError(404, ErrorCode.LOCATION_NOT_FOUND, "Location not found");
  }
  if (!location.isActive) {
    throw new AppError(409, ErrorCode.INACTIVE_LOCATION, "Location is not active");
  }
}

async function assertProductActive(productId: string) {
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

async function checkDiscountAuthorization(itemDiscountAmount: number | undefined, billDiscountAmount: number | undefined, userRole: string, lineTotal: number, subtotal: number) {
  if (itemDiscountAmount && itemDiscountAmount > 0) {
    const lineDiscountPct = (itemDiscountAmount / (lineTotal + itemDiscountAmount)) * 100;
    const check = await discountAuthRuleService.checkDiscountAuthorization("ITEM", lineDiscountPct, userRole);
    if (!check.authorized) {
      throw new AppError(403, ErrorCode.DISCOUNT_EXCEEDS_AUTHORIZED_LIMIT, `Item discount exceeds authorized limit of ${check.maxAllowed}%`, { requiredRole: check.requiredRole });
    }
  }

  if (billDiscountAmount && billDiscountAmount > 0) {
    const billDiscountPct = (billDiscountAmount / (subtotal + billDiscountAmount)) * 100;
    const check = await discountAuthRuleService.checkDiscountAuthorization("BILL", billDiscountPct, userRole);
    if (!check.authorized) {
      throw new AppError(403, ErrorCode.DISCOUNT_EXCEEDS_AUTHORIZED_LIMIT, `Bill discount exceeds authorized limit of ${check.maxAllowed}%`, { requiredRole: check.requiredRole });
    }
  }
}

export const saleService = {
  async list(query: SaleListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.SaleWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.cashierId ? { cashierId: query.cashierId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: query.dateFrom } : {}),
              ...(query.dateTo ? { lte: query.dateTo } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.sale.findMany({
        where,
        include: {
          location: { select: { id: true, name: true } },
          cashier: { select: { id: true, name: true } },
          _count: { select: { lines: true, payments: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.sale.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateSaleInput, actor: Pick<AuthenticatedUser, "id" | "role">) {
    await assertLocationActive(input.locationId);

    // Validate all products and check stock
    for (const line of input.lines) {
      await assertProductActive(line.productId);

      // Check stock availability at location
      const stock = await prisma.inventoryStock.findFirst({
        where: {
          productId: line.productId,
          locationId: input.locationId,
          quantity: { gte: line.quantityBaseUnits },
        },
        select: { id: true, quantity: true, batchId: true },
      });

      if (!stock) {
        throw new AppError(
          409,
          ErrorCode.INSUFFICIENT_STOCK_FOR_SALE,
          `Insufficient stock for product at location`,
          { productId: line.productId, required: line.quantityBaseUnits, available: 0 }
        );
      }
    }

    // Calculate totals
    let subtotal = 0;
    const lineTotals: number[] = [];

    for (const line of input.lines) {
      const lineTotal = line.unitPrice * line.quantity - (line.itemDiscountAmount ?? 0);
      subtotal += lineTotal;
      lineTotals.push(lineTotal);
    }

    const billDiscountAmount = input.billDiscountAmount ?? 0;
    const totalAmount = subtotal - billDiscountAmount;

    // Validate payment amounts sum to total
    const paymentSum = input.payments.reduce((sum, p) => sum + p.amount, 0);
    if (Math.abs(paymentSum - totalAmount) > 0.01) {
      throw new AppError(422, ErrorCode.BAD_REQUEST, "Payment amounts must sum to total amount");
    }

    // Check discount authorization
    await checkDiscountAuthorization(
      undefined, // We check per line below
      input.billDiscountAmount,
      actor.role,
      0,
      subtotal
    );

    // Check item discounts
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      const lineTotal = lineTotals[i];
      if (line.itemDiscountAmount && line.itemDiscountAmount > 0) {
        const lineDiscountPct = (line.itemDiscountAmount / (lineTotal + line.itemDiscountAmount)) * 100;
        const check = await discountAuthRuleService.checkDiscountAuthorization("ITEM", lineDiscountPct, actor.role);
        if (!check.authorized) {
          throw new AppError(403, ErrorCode.DISCOUNT_EXCEEDS_AUTHORIZED_LIMIT, `Line ${i + 1} discount exceeds authorized limit of ${check.maxAllowed}%`, { requiredRole: check.requiredRole });
        }
      }
    }

    if (billDiscountAmount > 0) {
      const billDiscountPct = (billDiscountAmount / (subtotal + billDiscountAmount)) * 100;
      const check = await discountAuthRuleService.checkDiscountAuthorization("BILL", billDiscountPct, actor.role);
      if (!check.authorized) {
        throw new AppError(403, ErrorCode.DISCOUNT_EXCEEDS_AUTHORIZED_LIMIT, `Bill discount exceeds authorized limit of ${check.maxAllowed}%`, { requiredRole: check.requiredRole });
      }
    }

    const sale = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: {
          saleNumber: generateSaleNumber(),
          cashierId: actor.id,
          locationId: input.locationId,
          subtotal,
          totalDiscount: billDiscountAmount,
          totalAmount,
          paidAmount: paymentSum,
          status: "COMPLETED",
          lines: {
            create: input.lines.map((line, i) => ({
              productId: line.productId,
              unitSold: line.unitSold,
              quantity: line.quantity,
              quantityBaseUnits: line.quantityBaseUnits,
              unitPrice: line.unitPrice,
              itemDiscountAmount: line.itemDiscountAmount ?? 0,
              lineTotal: lineTotals[i],
            })),
          },
          payments: {
            create: input.payments.map((p) => ({
              method: p.method,
              amount: p.amount,
              reference: p.reference,
            })),
          },
        },
      });

      // Record stock movements for each line
      for (const line of input.lines) {
        // Find available stock (FIFO - oldest batch first)
        const stockItems = await tx.inventoryStock.findMany({
          where: {
            productId: line.productId,
            locationId: input.locationId,
            quantity: { gt: 0 },
          },
          include: { batch: true },
          orderBy: { batch: { expiryDate: "asc" } }, // FEFO - First Expired First Out
        });

        let remainingQty = line.quantityBaseUnits;
        for (const stockItem of stockItems) {
          if (remainingQty <= 0) break;
          const qtyToDeduct = Math.min(remainingQty, stockItem.quantity.toNumber());
          remainingQty -= qtyToDeduct;

          // Record stock movement
          await stockMovementService.recordMovement({
            productId: line.productId,
            batchId: stockItem.batchId,
            locationId: input.locationId,
            transactionType: "SALE",
            direction: "OUT",
            quantity: qtyToDeduct,
            referenceType: "Sale",
            referenceId: sale.id,
            notes: `Sale ${sale.saleNumber}`,
            actor,
          });
        }
      }

      return sale;
    });

    return this.getById(sale.id);
  },

  async getById(id: string) {
    const sale = await prisma.sale.findUnique({
      where: { id },
      include: {
        location: { select: { id: true, name: true } },
        cashier: { select: { id: true, name: true } },
        lines: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
          },
        },
        payments: true,
      },
    });

    if (!sale) {
      throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
    }

    return sale;
  },

  async update(id: string, input: UpdateSaleInput) {
    const sale = await prisma.sale.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!sale) {
      throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
    }

    // If voiding, check it's not already voided
    if (input.status === "CANCELLED" && sale.status === "CANCELLED") {
      throw new AppError(409, ErrorCode.SALE_ALREADY_VOIDED, "Sale is already voided");
    }

    return prisma.sale.update({
      where: { id },
      data: {
        status: input.status,
        cancelReason: input.voidReason ?? undefined,
      },
    });
  },

  async voidSale(id: string, voidReason: string, actor: Pick<AuthenticatedUser, "id">) {
    const sale = await prisma.sale.findUnique({
      where: { id },
      include: {
        lines: {
          include: { product: { select: { id: true } } },
        },
      },
    });

    if (!sale) {
      throw new AppError(404, ErrorCode.SALE_NOT_FOUND, "Sale not found");
    }
    if (sale.status === "CANCELLED") {
      throw new AppError(409, ErrorCode.SALE_ALREADY_VOIDED, "Sale is already voided");
    }

    // Reverse stock movements
    await prisma.$transaction(async (tx) => {
      for (const line of sale.lines) {
        // Find the stock movements for this sale
        const movements = await tx.stockTransaction.findMany({
          where: {
            referenceType: "Sale",
            referenceId: sale.id,
            productId: line.productId,
            direction: "OUT",
          },
          select: { batchId: true, quantity: true, locationId: true },
        });

        // Reverse each movement
        for (const movement of movements) {
          await stockMovementService.recordMovement({
            productId: line.productId,
            batchId: movement.batchId,
            locationId: movement.locationId,
            transactionType: "RETURN_IN",
            direction: "IN",
            quantity: movement.quantity,
            referenceType: "SaleVoid",
            referenceId: sale.id,
            notes: `Void of sale ${sale.saleNumber}: ${voidReason}`,
            actor,
          });
        }
      }

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: "CANCELLED",
          cancelReason: voidReason,
        },
      });
    });

    return this.getById(id);
  },

  async getDetail(query: { page?: number; limit?: number; saleId?: string; productId?: string; cashierId?: string; locationId?: string; dateFrom?: Date; dateTo?: Date }) {
    const { page, limit, skip, take } = resolvePagination(query);
    const { start, end } = getDateRange(query.dateFrom, query.dateTo);

    const where: Prisma.SaleLineWhereInput = {
      sale: {
        status: "COMPLETED",
        createdAt: { gte: start, lte: end },
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.cashierId ? { cashierId: query.cashierId } : {}),
      },
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.saleId ? { saleId: query.saleId } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.saleLine.findMany({
        where,
        include: {
          sale: {
            select: {
              id: true,
              saleNumber: true,
              createdAt: true,
              location: { select: { id: true, name: true } },
              cashier: { select: { id: true, name: true } },
            },
          },
          product: {
            select: { id: true, name: true, sku: true, productGroup: { select: { id: true, name: true } } },
          },
        },
        orderBy: { sale: { createdAt: "desc" } },
        skip,
        take,
      }),
      prisma.saleLine.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};

function getDateRange(dateFrom?: Date, dateTo?: Date) {
  const end = dateTo ? new Date(dateTo) : new Date();
  end.setHours(23, 59, 59, 999);
  const start = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}