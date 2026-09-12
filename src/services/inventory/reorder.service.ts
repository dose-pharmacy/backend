import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type ReorderConfigInput = {
  minimumStockLevel: number;
  reorderPoint: number;
  leadTimeDays?: number;
  reorderQuantity: number;
  useSalesVelocity?: boolean;
  bufferPercentage?: number;
};

export type ReorderConfig = {
  id: string;
  productId: string;
  product: { id: string; name: string; sku: string; minimumStock: Prisma.Decimal; reorderPoint: Prisma.Decimal | null };
  minimumStockLevel: number;
  reorderPoint: number;
  leadTimeDays: number;
  reorderQuantity: number;
  useSalesVelocity: boolean;
  bufferPercentage: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ReorderDashboardQuery = PageQuery & {
  urgency?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
};

export type ReorderItem = {
  product: { id: string; name: string; sku: string; brand: string | null; baseUnit: { id: string; name: string; symbol: string | null } | null };
  currentStock: number;
  minimumThreshold: number;
  reorderPoint: number;
  suggestedQuantity: number;
  urgency: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  leadTimeDays: number;
  useSalesVelocity: boolean;
  hasSalesData: boolean;
};

export type ReorderDashboardResult = {
  items: ReorderItem[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    totalItems: number;
    totalSuggestedQuantity: number;
  };
};

export type ReorderSuggestionsQuery = PageQuery;

export type ReorderSuggestionItem = {
  product: { id: string; name: string; sku: string; brand: string | null; baseUnit: { id: string; name: string; symbol: string | null } | null };
  currentStock: number;
  reorderPoint: number;
  minimumStockLevel: number;
  suggestedQuantity: number;
  calculationMethod: "CONFIGURED" | "SALES_VELOCITY";
  leadTimeDays: number;
  averageDailySales: number | null;
  bufferQuantity: number;
  hasSalesData: boolean;
};

export const reorderService = {
  async getConfig(productId: string): Promise<ReorderConfig | null> {
    const config = await prisma.reorderConfiguration.findUnique({
      where: { productId },
      include: {
        product: {
          select: { id: true, name: true, sku: true, minimumStock: true, reorderPoint: true },
        },
      },
    });

    if (!config) {
      return null;
    }

    return {
      ...config,
      minimumStockLevel: config.minimumStockLevel.toNumber(),
      reorderPoint: config.reorderPoint.toNumber(),
      reorderQuantity: config.reorderQuantity.toNumber(),
      bufferPercentage: config.bufferPercentage.toNumber(),
    };
  },

  async upsertConfig(productId: string, input: ReorderConfigInput): Promise<ReorderConfig> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    const config = await prisma.reorderConfiguration.upsert({
      where: { productId },
      create: {
        productId,
        minimumStockLevel: input.minimumStockLevel,
        reorderPoint: input.reorderPoint,
        leadTimeDays: input.leadTimeDays ?? 7,
        reorderQuantity: input.reorderQuantity,
        useSalesVelocity: input.useSalesVelocity ?? false,
        bufferPercentage: input.bufferPercentage ?? 20,
      },
      update: {
        minimumStockLevel: input.minimumStockLevel,
        reorderPoint: input.reorderPoint,
        leadTimeDays: input.leadTimeDays ?? 7,
        reorderQuantity: input.reorderQuantity,
        useSalesVelocity: input.useSalesVelocity ?? false,
        bufferPercentage: input.bufferPercentage ?? 20,
      },
      include: {
        product: {
          select: { id: true, name: true, sku: true, minimumStock: true, reorderPoint: true },
        },
      },
    });

    return {
      ...config,
      minimumStockLevel: config.minimumStockLevel.toNumber(),
      reorderPoint: config.reorderPoint.toNumber(),
      reorderQuantity: config.reorderQuantity.toNumber(),
      bufferPercentage: config.bufferPercentage.toNumber(),
    };
  },

  async getDashboard(query: ReorderDashboardQuery): Promise<ReorderDashboardResult> {
    const { skip, take } = resolvePagination(query);

    // Get all products with reorder config
    const configs = await prisma.reorderConfiguration.findMany({
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            brand: true,
            units: {
              where: { isBaseUnit: true },
              take: 1,
              select: { unit: { select: { id: true, name: true, symbol: true } } },
            },
          },
        },
      },
    });

    const productIds = configs.map((c) => c.productId);

    // Get current stock for these products
    const stockAgg = await prisma.inventoryStock.groupBy({
      by: ["productId"],
      where: {
        productId: { in: productIds },
        quantity: { gt: 0 },
      },
      _sum: { quantity: true },
    });
    const stockMap = new Map(
      stockAgg.map((row) => [row.productId, row._sum.quantity?.toNumber() ?? 0]),
    );

    // Check if sales data exists (for future POS integration)
    // For now, no sales data exists
    const hasSalesData = false;
    const averageDailySalesMap = new Map<string, number>();

    // Build reorder items
    let items: ReorderItem[] = configs.map((config) => {
      const currentStock = stockMap.get(config.productId) ?? 0;
      const reorderPoint = config.reorderPoint.toNumber();
      const minimumStockLevel = config.minimumStockLevel.toNumber();
      const reorderQuantity = config.reorderQuantity.toNumber();
      const leadTimeDays = config.leadTimeDays;
      const useSalesVelocity = config.useSalesVelocity;
      const bufferPercentage = config.bufferPercentage.toNumber();

      let urgency: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      if (currentStock <= 0) {
        urgency = "CRITICAL";
      } else if (currentStock <= minimumStockLevel) {
        urgency = "HIGH";
      } else if (currentStock <= reorderPoint) {
        urgency = "MEDIUM";
      } else {
        urgency = "LOW";
      }

      // Calculate suggested quantity
      let suggestedQuantity = reorderQuantity;
      if (useSalesVelocity && hasSalesData) {
        const avgDailySales = averageDailySalesMap.get(config.productId) ?? 0;
        const bufferQuantity = avgDailySales * leadTimeDays * (bufferPercentage / 100);
        suggestedQuantity = Math.ceil(avgDailySales * leadTimeDays + bufferQuantity);
      }

      return {
        product: {
          id: config.product.id,
          name: config.product.name,
          sku: config.product.sku,
          brand: config.product.brand,
          baseUnit: config.product.units[0]?.unit ?? null,
        },
        currentStock,
        minimumThreshold: minimumStockLevel,
        reorderPoint,
        suggestedQuantity,
        urgency,
        leadTimeDays,
        useSalesVelocity,
        hasSalesData,
      };
    });

    // Filter by urgency if provided
    if (query.urgency) {
      items = items.filter((item) => item.urgency === query.urgency);
    }

    // Sort by urgency (CRITICAL first)
    const urgencyOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    items.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    const summary = {
      critical: items.filter((i) => i.urgency === "CRITICAL").length,
      high: items.filter((i) => i.urgency === "HIGH").length,
      medium: items.filter((i) => i.urgency === "MEDIUM").length,
      low: items.filter((i) => i.urgency === "LOW").length,
      totalItems: items.length,
      totalSuggestedQuantity: items.reduce((sum, i) => sum + i.suggestedQuantity, 0),
    };

    // Apply pagination after sorting/filtering
    const paginatedItems = items.slice(skip, skip + take);

    return { items: paginatedItems, summary };
  },

  async getSuggestions(query: ReorderSuggestionsQuery): Promise<{ items: ReorderSuggestionItem[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    const { page, limit, skip, take } = resolvePagination(query);

    // Get all products with reorder config
    const configs = await prisma.reorderConfiguration.findMany({
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            brand: true,
            units: {
              where: { isBaseUnit: true },
              take: 1,
              select: { unit: { select: { id: true, name: true, symbol: true } } },
            },
          },
        },
      },
    });

    const productIds = configs.map((c) => c.productId);

    // Get current stock
    const stockAgg = await prisma.inventoryStock.groupBy({
      by: ["productId"],
      where: {
        productId: { in: productIds },
        quantity: { gt: 0 },
      },
      _sum: { quantity: true },
    });
    const stockMap = new Map(
      stockAgg.map((row) => [row.productId, row._sum.quantity?.toNumber() ?? 0]),
    );

    // No sales data available yet
    const hasSalesData = false;
    const averageDailySalesMap = new Map<string, number>();

    const items: ReorderSuggestionItem[] = configs
      .filter((config) => {
        const currentStock = stockMap.get(config.productId) ?? 0;
        const reorderPoint = config.reorderPoint.toNumber();
        // Only suggest for products at or below reorder point
        return currentStock <= reorderPoint;
      })
      .map((config) => {
        const currentStock = stockMap.get(config.productId) ?? 0;
        const reorderPoint = config.reorderPoint.toNumber();
        const minimumStockLevel = config.minimumStockLevel.toNumber();
        const reorderQuantity = config.reorderQuantity.toNumber();
        const leadTimeDays = config.leadTimeDays;
        const useSalesVelocity = config.useSalesVelocity;
        const bufferPercentage = config.bufferPercentage.toNumber();

        let suggestedQuantity = reorderQuantity;
        let calculationMethod: "CONFIGURED" | "SALES_VELOCITY" = "CONFIGURED";
        let averageDailySales: number | null = null;
        let bufferQuantity = 0;

        if (useSalesVelocity && hasSalesData) {
          averageDailySales = averageDailySalesMap.get(config.productId) ?? 0;
          bufferQuantity = averageDailySales * leadTimeDays * (bufferPercentage / 100);
          suggestedQuantity = Math.ceil(averageDailySales * leadTimeDays + bufferQuantity);
          calculationMethod = "SALES_VELOCITY";
        }

        return {
          product: {
            id: config.product.id,
            name: config.product.name,
            sku: config.product.sku,
            brand: config.product.brand,
            baseUnit: config.product.units[0]?.unit ?? null,
          },
          currentStock,
          reorderPoint,
          minimumStockLevel,
          suggestedQuantity,
          calculationMethod,
          leadTimeDays,
          averageDailySales,
          bufferQuantity,
          hasSalesData,
        };
      });

    // Sort by urgency (most urgent first)
    items.sort((a, b) => {
      const aUrgency = a.currentStock <= 0 ? 0 : a.currentStock <= a.minimumStockLevel ? 1 : 2;
      const bUrgency = b.currentStock <= 0 ? 0 : b.currentStock <= b.minimumStockLevel ? 1 : 2;
      return aUrgency - bUrgency;
    });

    const paginatedItems = items.slice(skip, skip + take);
    const meta = buildPaginationMeta(items.length, page, limit);

    return { items: paginatedItems, meta };
  },
};