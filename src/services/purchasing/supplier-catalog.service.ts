import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";
import { startOfTodayUtc } from "../../utils/date-time.js";

/**
 * ============================================================================
 * Supplier Catalog Service
 * ============================================================================
 *
 * Backend support for the Purchase Return flow:
 *
 *   Select Supplier -> products purchased from that supplier
 *   Select Product  -> batches of that product traceable to the supplier
 *   Select Location -> per-location available quantities
 *   Enter quantity  -> POST /purchase-returns (server re-validates everything)
 *
 * Supplier -> product relationship: `PurchaseOrder.supplierId` joined through
 * `PurchaseOrderItem.productId`. There is no direct Product.supplierId in the
 * schema; a product is "associated with a supplier" when it was actually
 * ordered (and, for batches, received) from that supplier.
 *
 * Supplier -> batch relationship: `Batch.supplierId`, which the goods-receipt
 * confirmation stamps from the PO's supplier when it creates the batch.
 *
 * All filtering happens in PostgreSQL (Prisma relation filters), never by
 * loading everything into Node.
 */

export type SupplierProductListQuery = PageQuery & {
  search?: string;
  /** Only active products by default; pass false to include deactivated. */
  isActive?: boolean;
};

export type SupplierProductBatchQuery = {
  /** Only batches with available stock at some location (default true). */
  inStock?: boolean;
  /** Exclude batches already expired (default true). */
  excludeExpired?: boolean;
  /** Narrow the per-location stock rows to one location. */
  locationId?: string;
};

const PRODUCT_SELECTION = {
  id: true,
  name: true,
  genericName: true,
  brand: true,
  sku: true,
  isActive: true,
  isNarcotic: true,
} satisfies Prisma.ProductSelect;

async function assertSupplierExists(supplierId: string): Promise<void> {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true },
  });
  if (!supplier) {
    throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
  }
}

export const supplierCatalogService = {
  /**
   * Products actually ordered from the given supplier (via PO items),
   * database-filtered, searchable and paginated with the standard
   * page/limit conventions.
   */
  async listProductsForSupplier(
    supplierId: string,
    query: SupplierProductListQuery,
  ): Promise<{ items: unknown[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    await assertSupplierExists(supplierId);
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.ProductWhereInput = {
      isActive: query.isActive ?? true,
      // Supplier relationship = ordered from this supplier at least once.
      purchaseOrderItems: {
        some: { purchaseOrder: { supplierId } },
      },
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
    };

    const [items, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: PRODUCT_SELECTION,
        orderBy: { name: "asc" },
        skip,
        take,
      }),
      prisma.product.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  /**
   * Batches of one product traceable to one supplier, each with its
   * per-location available stock (quantity - reserved, POS convention).
   *
   * Ownership rule: a batch belongs to the supplier only when
   * `Batch.supplierId = supplierId` (stamped at goods-receipt confirmation).
   * Batches received from other suppliers are excluded. Batches whose
   * supplier is unknown (NULL — e.g. created manually before the supplier
   * stamping existed) are also excluded rather than misattributed; such
   * batches remain visible in the normal batch endpoints.
   */
  async listBatchesForSupplierProduct(
    supplierId: string,
    productId: string,
    query: SupplierProductBatchQuery = {},
  ): Promise<{ items: unknown[]; supplier: { id: string; name: string }; product: { id: string; name: string } }> {
    const [supplier, product] = await Promise.all([
      prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true } }),
      prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true } }),
    ]);
    if (!supplier) {
      throw new AppError(404, ErrorCode.SUPPLIER_NOT_FOUND, "Supplier not found");
    }
    if (!product) {
      throw new AppError(404, ErrorCode.PRODUCT_NOT_FOUND, "Product not found");
    }

    const today = startOfTodayUtc();

    // One round trip: batch rows (with their stock rows) for the
    // supplier+product pair, stock filtered to requested location and
    // positive quantity directly in SQL.
    const batches = await prisma.batch.findMany({
      where: {
        productId,
        supplierId,
        ...(query.excludeExpired === false ? {} : { expiryDate: { gte: today } }),
        ...(query.inStock === false
          ? {}
          : { stock: { some: { quantity: { gt: 0 }, ...(query.locationId ? { locationId: query.locationId } : {}) } } }),
      },
      select: {
        id: true,
        batchNumber: true,
        expiryDate: true,
        purchaseCost: true,
        receivedDate: true,
        stock: {
          where: { quantity: { gt: 0 }, ...(query.locationId ? { locationId: query.locationId } : {}) },
          select: {
            locationId: true,
            location: { select: { id: true, name: true } },
            quantity: true,
            reservedQuantity: true,
          },
          orderBy: { location: { name: "asc" } },
        },
      },
      orderBy: [{ expiryDate: "asc" }, { batchNumber: "asc" }],
    });

    const items = batches
      .map((batch) => ({
        id: batch.id,
        batchNumber: batch.batchNumber,
        productId,
        productName: product.name,
        supplierId,
        expiryDate: batch.expiryDate,
        purchaseCost: batch.purchaseCost,
        receivedDate: batch.receivedDate,
        // One entry per location holding the batch. availableQuantity uses the
        // system-wide convention: quantity - reservedQuantity.
        locations: batch.stock
          .map((stock) => ({
            locationId: stock.location.id,
            locationName: stock.location.name,
            availableQuantity: stock.quantity.minus(stock.reservedQuantity).toNumber(),
          }))
          .filter((row) => row.availableQuantity > 0),
      }))
      // Drop batches whose only stock is fully reserved.
      .filter((batch) => query.inStock === false || batch.locations.length > 0);

    return { items, supplier: { id: supplier.id, name: supplier.name }, product: { id: product.id, name: product.name } };
  },
};
