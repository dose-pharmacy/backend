import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { productGroupRepository } from "../../repositories/inventory/product-group.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { productUnitRepository } from "../../repositories/inventory/product-unit.repository.js";
import { inventoryStockRepository } from "../../repositories/inventory/inventory-stock.repository.js";
import { unitRepository } from "../../repositories/inventory/unit.repository.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import { toDecimal } from "../../utils/decimal.js";
import { prisma } from "../../database/prisma.js";
import type { PageQuery } from "../../utils/pagination.js";
import { calculateStockStatus } from "./inventory-product.service.js";
import { pricingService } from "./pricing.service.js";
import type { PricingStatusFilter } from "./pricing.service.js";
import { AuditEvent, recordAuditEvent } from "../audit/audit-events.js";
import type { AuthenticatedUser } from "../../types/auth.js";

export type ProductUnitConfigInput = {
  /** Id of a reusable master Unit (e.g. \"Box\"). */
  unitId: string;
  /** How many base units one of these units equals. Base unit must be 1. */
  conversionFactor: number;
  sellPrice?: number;
  purchasePrice?: number;
  isBaseUnit?: boolean;
};

export type CreateProductInput = {
  name: string;
  genericName?: string;
  brand?: string;
  sku: string;
  productGroupId: string;
  description?: string;
  imageUrl?: string;
  minimumStock?: number;
  reorderPoint?: number;
  isActive?: boolean;
  /** Narcotic/controlled product flag (MVP boolean). Defaults to false. */
  isNarcotic?: boolean;
  /**
   * Optional embedded unit configuration created atomically with the product.
   * Exactly one entry must be the base unit (conversionFactor = 1).
   * When omitted, the product is created without units (legacy flow; units
   * can be added later via POST /products/:productId/units).
   */
  units?: ProductUnitConfigInput[];
};

export type UpdateProductInput = Partial<CreateProductInput> & {
  imageUrl?: string | null;
  reorderPoint?: number | null;
};

export type ListProductsQuery = PageQuery & {
  search?: string;
  productGroupId?: string;
  brand?: string;
  isActive?: boolean;
  /** Filter by the pricing/margin warning status (`ALL` = no filter). */
  pricingStatus?: PricingStatusFilter;
};

type ProductGroupCount = { productGroupId: string; count: number };

/** Resolves product-group names for the list summary counts. */
async function withProductGroupNames(rows: ProductGroupCount[]) {
  const groupIds = rows.map((row) => row.productGroupId);
  const groups = groupIds.length
    ? await prisma.productGroup.findMany({
        where: { id: { in: groupIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(groups.map((group) => [group.id, group.name]));
  return rows
    .map((row) => ({
      productGroupId: row.productGroupId,
      productGroupName: nameById.get(row.productGroupId) ?? "Unknown",
      count: row.count,
    }))
    .sort((a, b) => b.count - a.count);
}

function toOptionalDecimal(value: number | null | undefined): Prisma.Decimal | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : toDecimal(value);
}

type ValidatedUnitConfig = {
  unitId: string;
  conversionFactor: Prisma.Decimal;
  sellPrice: Prisma.Decimal | null;
  purchasePrice: Prisma.Decimal | null;
  isBaseUnit: boolean;
};

/**
 * Validates an incoming unit configuration array:
 *  - every master unit exists and is active
 *  - no duplicate unit supplied
 *  - exactly one base unit
 *  - base unit conversion factor is exactly 1
 *  - non-base conversion factors are greater than zero
 * Returns the normalized configuration ready for persistence.
 */
async function validateUnitConfigs(
  units: ProductUnitConfigInput[],
): Promise<ValidatedUnitConfig[]> {
  if (units.length === 0) {
    throw new AppError(422, ErrorCode.BAD_REQUEST, "At least one unit configuration is required");
  }

  const seen = new Set<string>();
  const validated: ValidatedUnitConfig[] = [];
  let baseCount = 0;

  for (const unitConfig of units) {
    if (seen.has(unitConfig.unitId)) {
      throw new AppError(
        409,
        ErrorCode.DUPLICATE_UNIT,
        "The same unit cannot be configured twice for a product",
      );
    }
    seen.add(unitConfig.unitId);

    const unit = await unitRepository.findById(unitConfig.unitId);
    if (!unit) {
      throw new AppError(404, ErrorCode.UNIT_NOT_FOUND, "Unit not found");
    }
    if (!unit.isActive) {
      throw new AppError(409, ErrorCode.UNIT_INACTIVE, "Unit is not active");
    }

    const isBaseUnit = unitConfig.isBaseUnit === true;
    if (isBaseUnit) {
      baseCount += 1;
      if (unitConfig.conversionFactor !== 1) {
        throw new AppError(
          409,
          ErrorCode.BASE_UNIT_FORBIDDEN,
          "The base unit of a product always has a conversion factor of 1",
        );
      }
    } else if (unitConfig.conversionFactor <= 0) {
      throw new AppError(
        422,
        ErrorCode.INVALID_CONVERSION_FACTOR,
        "Conversion factor must be greater than zero",
      );
    }

    validated.push({
      unitId: unitConfig.unitId,
      conversionFactor: toDecimal(unitConfig.conversionFactor),
      sellPrice: unitConfig.sellPrice !== undefined ? toDecimal(unitConfig.sellPrice) : null,
      purchasePrice:
        unitConfig.purchasePrice !== undefined ? toDecimal(unitConfig.purchasePrice) : null,
      isBaseUnit,
    });
  }

  if (baseCount === 0) {
    throw new AppError(409, ErrorCode.BASE_UNIT_REQUIRED, "Exactly one base unit is required");
  }
  if (baseCount > 1) {
    throw new AppError(409, ErrorCode.BASE_UNIT_EXISTS, "Only one base unit is allowed per product");
  }

  return validated;
}

export const productService = {
  async list(query: ListProductsQuery) {
    const { page, limit, skip, take } = resolvePagination(query);
    const pricingStatus =
      query.pricingStatus && query.pricingStatus !== "ALL" ? query.pricingStatus : undefined;

    // Pricing-status filtered list: the filter, the count and the pagination all
    // happen in the DATABASE (see pricing.service.ts), then only the requested
    // page is hydrated. Never fetch-then-filter-then-paginate in JavaScript.
    if (pricingStatus) {
      const filters = {
        search: query.search,
        productGroupId: query.productGroupId,
        brand: query.brand,
        isActive: query.isActive,
      };
      const [{ ids, total }, summarySource] = await Promise.all([
        pricingService.listProductIdsByPricingStatus({
          status: pricingStatus,
          filters,
          skip,
          take,
        }),
        pricingService.summarizeByPricingStatus({ status: pricingStatus, filters }),
      ]);

      const [rows, pricing] = await Promise.all([
        productRepository.findByIds(ids),
        pricingService.pricingForProductIds(ids),
      ]);
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const items = ids.flatMap((id) => {
        const row = rowById.get(id);
        return row ? [{ ...row, pricing: pricing.get(id) ?? null }] : [];
      });

      return {
        items,
        meta: buildPaginationMeta(total, page, limit),
        summary: {
          byStatus: summarySource.byStatus,
          byProductGroup: await withProductGroupNames(summarySource.byProductGroup),
        },
      };
    }

    const { items, total, where } = await productRepository.list({
      search: query.search,
      productGroupId: query.productGroupId,
      brand: query.brand,
      isActive: query.isActive,
      skip,
      take,
    });

    // Summary counts over the FILTERED dataset (not just the page).
    // NOTE: productGroupId is a NON-nullable column, so no "not null" filter
    // is needed here — `equals: null` inside `not` is rejected by Prisma and
    // made every product-list request fail validation.
    const [statusGroups, groupGroups, pricing] = await Promise.all([
      prisma.product.groupBy({ by: ["isActive"], where, orderBy: [], _count: true }),
      prisma.product.groupBy({
        by: ["productGroupId"],
        where,
        orderBy: [],
        _count: true,
      }),
      pricingService.pricingForProductIds(items.map((item) => item.id)),
    ] as const);

    const byStatus: { active: number; inactive: number } = { active: 0, inactive: 0 };
    for (const g of statusGroups) {
      byStatus[g.isActive ? "active" : "inactive"] = g._count;
    }

    const byProductGroup = await withProductGroupNames(
      groupGroups.map((g) => ({
        productGroupId: g.productGroupId as string,
        count: g._count as number,
      })),
    );

    return {
      items: items.map((item) => ({ ...item, pricing: pricing.get(item.id) ?? null })),
      meta: buildPaginationMeta(total, page, limit),
      summary: { byStatus, byProductGroup },
    };
  },

  async getById(id: string) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }
    return product;
  },

  /**
   * Product detail for the frontend detail page: product + product group +
   * units + a bounded stock summary. Batches and transaction history are
   * served by their own paginated endpoints.
   */
  async detail(id: string) {
    const product = await productRepository.findByIdDetailed(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    const [units, totalQuantity, byLocation, usages] = await Promise.all([
      productUnitRepository.findByProductId(id),
      inventoryStockRepository.totalQuantity(id),
      inventoryStockRepository.quantityByLocation(id),
      productRepository.countUsages(id),
    ]);

    // stock status
    const StockStatus = calculateStockStatus(totalQuantity.toNumber(), product.minimumStock, product.reorderPoint);

    const baseUnit = units.find((u) => u.isBaseUnit)?.unit ?? null;

    // Pricing / target-margin warning (read-only; never reprices the product).
    const pricing = (await pricingService.pricingForProductIds([id])).get(id) ?? null;

    return {
      ...product,
      baseUnit,
      units,
      stockSummary: {
        stockStatus: StockStatus,
        totalQuantity,
        baseUnit,
        byLocation,
      },
      batchCount: usages.batches,
      transactionCount: usages.transactions,
      locationCount: byLocation.length,
      pricing,
    };
  },

  /**
   * Creates a product and, when `units` is supplied, its ProductUnit
   * configurations in a single Prisma transaction.
   */
  async create(input: CreateProductInput, actor?: Pick<AuthenticatedUser, "id">) {
    const group = await productGroupRepository.findById(input.productGroupId);
    if (!group) {
      throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
    }

    const duplicate = await productRepository.findBySku(input.sku);
    if (duplicate) {
      throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
    }

    const validatedUnits =
      input.units !== undefined ? await validateUnitConfigs(input.units) : undefined;

    try {
      const product = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            name: input.name,
            genericName: input.genericName,
            brand: input.brand,
            sku: input.sku,
            productGroupId: input.productGroupId,
            description: input.description,
            imageUrl: input.imageUrl,
            minimumStock: toOptionalDecimal(input.minimumStock) ?? toDecimal(0),
            reorderPoint: toOptionalDecimal(input.reorderPoint),
            isActive: input.isActive,
            isNarcotic: input.isNarcotic,
          },
        });

      const reorderPoint = toOptionalDecimal(input.reorderPoint);

        await tx.reorderConfiguration.create({
          data: {
            productId: created.id,
            minimumStockLevel: toOptionalDecimal(input.minimumStock) ?? toDecimal(0),
            reorderPoint: toOptionalDecimal(input.reorderPoint) ?? toDecimal(0),
            leadTimeDays: 0,
            reorderQuantity: 0,
            useSalesVelocity: false,
            bufferPercentage: 0,
          },
        });

        if (validatedUnits) {
          await tx.productUnit.createMany({
            data: validatedUnits.map((unitConfig) => ({
              productId: created.id,
              unitId: unitConfig.unitId,
              conversionFactor: unitConfig.conversionFactor,
              sellPrice: unitConfig.sellPrice,
              purchasePrice: unitConfig.purchasePrice,
              isBaseUnit: unitConfig.isBaseUnit,
            })),
          });
        }

        // Audit INSIDE the same transaction: the product and its audit record
        // commit (or roll back) together.
        if (actor) {
          await recordAuditEvent(
            {
              event: AuditEvent.PRODUCT_CREATED,
              entityId: created.id,
              actorId: actor.id,
              metadata: {
                sku: created.sku,
                isNarcotic: created.isNarcotic,
                isActive: created.isActive,
              },
            },
            tx,
          );
        }

        return created;
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      });

      // Return the product with its units when they were created together,
      // so clients get the full picture without a second round trip.
      if (validatedUnits) {
        return productRepository.findByIdWithUnits(product.id);
      }
      return product;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
      throw error;
    }
  },

  /**
   * Updates product fields and, when `units` is supplied, safely upserts the
   * unit configuration: existing configs are updated (conversion factor /
   * prices), missing ones are created. The base unit cannot be removed or
   * re-designated here — use the dedicated unit endpoints for that.
   */
  async update(id: string, input: UpdateProductInput, actor?: Pick<AuthenticatedUser, "id">) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    if (input.productGroupId !== undefined && input.productGroupId !== product.productGroupId) {
      const group = await productGroupRepository.findById(input.productGroupId);
      if (!group) {
        throw new AppError(404, ErrorCode.PRODUCT_GROUP_NOT_FOUND, "Product group not found");
      }
    }

    if (input.sku !== undefined && input.sku.toLowerCase() !== product.sku.toLowerCase()) {
      const duplicate = await productRepository.findBySku(input.sku, id);
      if (duplicate) {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
    }

    const validatedUnits =
      input.units !== undefined ? await validateUnitConfigs(input.units) : undefined;

    try {
      return await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id },
          data: {
            name: input.name,
            genericName: input.genericName,
            brand: input.brand,
            sku: input.sku,
            productGroupId: input.productGroupId,
            description: input.description,
            imageUrl: input.imageUrl,
            minimumStock:
              input.minimumStock !== undefined ? toDecimal(input.minimumStock) : undefined,
            reorderPoint: toOptionalDecimal(input.reorderPoint) ?? toDecimal(0),
            isActive: input.isActive,
            isNarcotic: input.isNarcotic,
          },
        });

        if (input.minimumStock !== undefined || input.reorderPoint !== undefined) {
          await tx.reorderConfiguration.upsert({
            where: { productId: id },
            create: {
              productId: id,
              minimumStockLevel: toOptionalDecimal(input.minimumStock) ?? toDecimal(0),
              reorderPoint: toOptionalDecimal(input.reorderPoint) ?? toDecimal(0),
              leadTimeDays: 0,
              reorderQuantity: 0,
              useSalesVelocity: false,
              bufferPercentage: 0,
            },
            update: {
              minimumStockLevel: toOptionalDecimal(input.minimumStock) ?? toDecimal(0),
              reorderPoint: toOptionalDecimal(input.reorderPoint) ?? toDecimal(0),
            },
          });
        }

        if (validatedUnits) {
          const existingConfigs = await tx.productUnit.findMany({
            where: { productId: id },
            select: { id: true, unitId: true, isBaseUnit: true },
          });
          const byUnitId = new Map(existingConfigs.map((c) => [c.unitId, c]));
          const hasExistingBase = existingConfigs.some((c) => c.isBaseUnit);

          for (const unitConfig of validatedUnits) {
            const existing = byUnitId.get(unitConfig.unitId);
            if (existing) {
              // The base unit designation cannot be changed through a
              // product update (use the dedicated unit endpoints).
              if (!existing.isBaseUnit && unitConfig.isBaseUnit) {
                throw new AppError(
                  409,
                  ErrorCode.BASE_UNIT_FORBIDDEN,
                  "The base unit designation cannot be changed through a product update",
                );
              }
              // The base unit conversion factor is fixed at 1.
              if (existing.isBaseUnit && !unitConfig.conversionFactor.equals(1)) {
                throw new AppError(
                  409,
                  ErrorCode.BASE_UNIT_FORBIDDEN,
                  "The base unit of a product always has a conversion factor of 1",
                );
              }
              await tx.productUnit.update({
                where: { id: existing.id },
                data: {
                  conversionFactor: unitConfig.conversionFactor,
                  sellPrice: unitConfig.sellPrice,
                  purchasePrice: unitConfig.purchasePrice,
                },
              });
            } else if (unitConfig.isBaseUnit && hasExistingBase) {
              // Adding a second base unit is not allowed.
              throw new AppError(
                409,
                ErrorCode.BASE_UNIT_EXISTS,
                "This product already has a base unit",
              );
            } else {
              await tx.productUnit.create({
                data: {
                  productId: id,
                  unitId: unitConfig.unitId,
                  conversionFactor: unitConfig.conversionFactor,
                  sellPrice: unitConfig.sellPrice,
                  purchasePrice: unitConfig.purchasePrice,
                  isBaseUnit: unitConfig.isBaseUnit,
                },
              });
            }
          }
        }

        const updated = await productRepository.findByIdWithUnits(id);

        if (actor) {
          // isNarcotic transitions are always audited explicitly: flipping a
          // product into/out of controlled status is a compliance-relevant act.
          if (input.isNarcotic !== undefined && input.isNarcotic !== product.isNarcotic) {
            await recordAuditEvent(
              {
                event: AuditEvent.PRODUCT_UPDATED,
                entityId: id,
                actorId: actor.id,
                metadata: {
                  field: "isNarcotic",
                  oldValue: product.isNarcotic,
                  newValue: input.isNarcotic,
                },
              },
              tx,
            );
          } else if (input.isActive === false && product.isActive) {
            await recordAuditEvent(
              {
                event: AuditEvent.PRODUCT_DEACTIVATED,
                entityId: id,
                actorId: actor.id,
                metadata: { sku: product.sku },
              },
              tx,
            );
          } else {
            // Generic update: record only the fields that actually changed.
            const changedFields: Record<string, { oldValue: unknown; newValue: unknown }> = {};
            const track = <T>(field: string, oldValue: T, newValue: T | undefined) => {
              if (newValue !== undefined && newValue !== oldValue) {
                changedFields[field] = { oldValue, newValue };
              }
            };
            track("name", product.name, input.name);
            track("sku", product.sku, input.sku);
            track("brand", product.brand, input.brand);
            track("genericName", product.genericName, input.genericName);
            track("productGroupId", product.productGroupId, input.productGroupId);
            track("isActive", product.isActive, input.isActive);
            if (Object.keys(changedFields).length > 0) {
              await recordAuditEvent(
                {
                  event: AuditEvent.PRODUCT_UPDATED,
                  entityId: id,
                  actorId: actor.id,
                  metadata: changedFields as unknown as Prisma.InputJsonValue,
                },
                tx,
              );
            }
          }
        }

        return updated;
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.DUPLICATE_SKU, "A product with this SKU already exists");
      }
      throw error;
    }
  },

  async remove(id: string) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    const usages = await productRepository.countUsages(id);
    if (
      usages.units > 0 ||
      usages.batches > 0 ||
      usages.stock > 0 ||
      usages.transactions > 0
    ) {
      throw new AppError(
        409,
        ErrorCode.PRODUCT_IN_USE,
        "Cannot delete a product that has units, batches, stock, or transaction history",
        usages,
      );
    }

    await productRepository.deleteById(id);
  },
};