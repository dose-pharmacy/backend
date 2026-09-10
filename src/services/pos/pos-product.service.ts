import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export type PosProductListQuery = PageQuery & {
  search?: string;
  brand?: string;
  productGroupId?: string;
  locationId?: string;
};

/**
 * POS product selection.
 *
 * Only ACTIVE products that have at least one selling unit (an active master
 * unit with a configured sellPrice) are returned. Each selling unit carries
 * its own unit-specific price (ProductUnit.sellPrice) — the price is never
 * derived as `base price x conversion factor`.
 *
 * `availableStock = quantity - reservedQuantity` is computed server-side for
 * the requested location (or aggregated across locations when `locationId`
 * is omitted). Stock is always expressed in the product's BASE unit.
 */
export const posProductService = {
  async listProducts(query: PosProductListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(query.brand
        ? { brand: { equals: query.brand, mode: "insensitive" as const } }
        : {}),
      ...(query.productGroupId ? { productGroupId: query.productGroupId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              { genericName: { contains: query.search, mode: "insensitive" as const } },
              { brand: { contains: query.search, mode: "insensitive" as const } },
              { sku: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      // Only products that can actually be sold right now: active product
      // with at least one active master unit configured with a sell price.
      units: {
        some: { unit: { isActive: true }, sellPrice: { not: null } },
      },
    };

    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          genericName: true,
          brand: true,
          sku: true,
          isActive: true,
          minimumStock: true,
          reorderPoint: true,
          productGroup: { select: { id: true, name: true } },
          units: {
            where: { unit: { isActive: true }, sellPrice: { not: null } },
            include: {
              unit: { select: { id: true, name: true, symbol: true } },
            },
            orderBy: [{ isBaseUnit: "desc" }, { createdAt: "asc" }],
          },
        },
        orderBy: { name: "asc" },
        skip,
        take,
      }),
      prisma.product.count({ where }),
    ]);

    const productIds = products.map((product) => product.id);
    const stockAgg = await prisma.inventoryStock.groupBy({
      by: ["productId"],
      where: {
        productId: { in: productIds },
        quantity: { gt: 0 },
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      _sum: { quantity: true, reservedQuantity: true },
    });
    const stockMap = new Map(
      stockAgg.map((row) => [
        row.productId,
        {
          quantity: row._sum.quantity?.toNumber() ?? 0,
          reserved: row._sum.reservedQuantity?.toNumber() ?? 0,
        },
      ]),
    );

    const items = products.map((product) => {
      const { quantity, reserved } = stockMap.get(product.id) ?? {
        quantity: 0,
        reserved: 0,
      };
      const availableStock = Math.max(0, quantity - reserved);
      const threshold =
        product.reorderPoint?.toNumber() ?? product.minimumStock.toNumber();
      const stockStatus: StockStatus =
        availableStock <= 0
          ? "OUT_OF_STOCK"
          : availableStock <= threshold
            ? "LOW_STOCK"
            : "IN_STOCK";

      return {
        id: product.id,
        name: product.name,
        genericName: product.genericName,
        brand: product.brand,
        sku: product.sku,
        productGroup: product.productGroup,
        isActive: product.isActive,
        baseUnit: product.units.find((unit) => unit.isBaseUnit)?.unit ?? null,
        units: product.units.map((unit) => ({
          id: unit.id,
          unitId: unit.unit.id,
          unitName: unit.unit.name,
          unitSymbol: unit.unit.symbol,
          conversionFactor: unit.conversionFactor,
          sellPrice: unit.sellPrice,
          isBaseUnit: unit.isBaseUnit,
        })),
        totalStock: quantity,
        reservedStock: reserved,
        availableStock,
        stockStatus,
      };
    });

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },
};