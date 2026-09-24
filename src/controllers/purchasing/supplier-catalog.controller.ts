import type { Request, Response } from "express";
import {
  supplierCatalogService,
  type SupplierProductBatchQuery,
  type SupplierProductListQuery,
  type SupplierReceivedProductsQuery,
} from "../../services/purchasing/supplier-catalog.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const supplierCatalogController = {
  /** GET /suppliers/:supplierId/products — products ordered from this supplier. */
  listProductsForSupplier: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SupplierProductListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
    };
    const { items, meta } = await supplierCatalogService.listProductsForSupplier(
      req.params.supplierId as string,
      input,
    );
    sendSuccess(res, items, { meta });
  }),

  /**
   * GET /suppliers/:supplierId/products/:productId/batches — batches of the
   * product traceable to the supplier, with per-location available stock.
   */
  listBatchesForSupplierProduct: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SupplierProductBatchQuery = {
      inStock: query.inStock === "false" ? false : true,
      excludeExpired: query.excludeExpired === "false" ? false : true,
      locationId: query.locationId,
    };
    const data = await supplierCatalogService.listBatchesForSupplierProduct(
      req.params.supplierId as string,
      req.params.productId as string,
      input,
    );
    sendSuccess(res, data.items, {
      summary: { supplier: data.supplier, product: data.product },
    });
  }),

  /**
   * GET /suppliers/:supplierId/received-products — products received from the
   * supplier grouped with their batches, purchase cost per unit and current stock.
   */
  listReceivedProductsForSupplier: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SupplierReceivedProductsQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: query.search,
      inStock: query.inStock === "false" ? false : true,
      excludeExpired: query.excludeExpired === "false" ? false : true,
      locationId: query.locationId,
    };
    const data = await supplierCatalogService.listReceivedProductsForSupplier(
      req.params.supplierId as string,
      input,
    );
    sendSuccess(res, data.items, { meta: data.meta, summary: data.supplier });
  }),
};
