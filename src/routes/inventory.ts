import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { batchController } from "../controllers/inventory/batch.controller.js";
import { locationController } from "../controllers/inventory/location.controller.js";
import { productController } from "../controllers/inventory/product.controller.js";
import { productGroupController } from "../controllers/inventory/product-group.controller.js";
import { stockController } from "../controllers/inventory/stock.controller.js";
import { unitController } from "../controllers/inventory/unit.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  batchListQuerySchema,
  batchParamsSchema,
  createBatchSchema,
  updateBatchSchema,
} from "../validators/inventory/batch.js";
import { productIdParamSchema } from "../validators/inventory/common.js";
import {
  createLocationSchema,
  locationListQuerySchema,
  locationParamsSchema,
  updateLocationSchema,
} from "../validators/inventory/location.js";
import {
  createProductGroupSchema,
  productGroupListQuerySchema,
  productGroupParamsSchema,
  updateProductGroupSchema,
} from "../validators/inventory/product-group.js";
import {
  createProductSchema,
  productListQuerySchema,
  productParamsSchema,
  updateProductSchema,
} from "../validators/inventory/product.js";
import {
  openingStockSchema,
  productTransactionsQuerySchema,
  stockAdjustmentSchema,
  stockListQuerySchema,
} from "../validators/inventory/stock.js";
import {
  convertUnitsSchema,
  createProductUnitSchema,
  unitParamsSchema,
  updateProductUnitSchema,
} from "../validators/inventory/unit.js";

export const inventoryRouter = Router();

// Only ADMIN may access inventory in this phase.
const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

// ---------------------------------------------------------------------------
// Product groups
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/product-groups",
  ...admin,
  validate({ query: productGroupListQuerySchema }),
  productGroupController.list,
);
inventoryRouter.post(
  "/product-groups",
  ...admin,
  validate({ body: createProductGroupSchema }),
  productGroupController.create,
);
inventoryRouter.get(
  "/product-groups/:id",
  ...admin,
  validate({ params: productGroupParamsSchema }),
  productGroupController.getById,
);
inventoryRouter.patch(
  "/product-groups/:id",
  ...admin,
  validate({ params: productGroupParamsSchema, body: updateProductGroupSchema }),
  productGroupController.update,
);
inventoryRouter.delete(
  "/product-groups/:id",
  ...admin,
  validate({ params: productGroupParamsSchema }),
  productGroupController.remove,
);

// ---------------------------------------------------------------------------
// Inventory locations
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/locations",
  ...admin,
  validate({ query: locationListQuerySchema }),
  locationController.list,
);
inventoryRouter.post(
  "/locations",
  ...admin,
  validate({ body: createLocationSchema }),
  locationController.create,
);
inventoryRouter.get(
  "/locations/:id",
  ...admin,
  validate({ params: locationParamsSchema }),
  locationController.getById,
);
inventoryRouter.patch(
  "/locations/:id",
  ...admin,
  validate({ params: locationParamsSchema, body: updateLocationSchema }),
  locationController.update,
);
inventoryRouter.delete(
  "/locations/:id",
  ...admin,
  validate({ params: locationParamsSchema }),
  locationController.remove,
);

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/products",
  ...admin,
  validate({ query: productListQuerySchema }),
  productController.list,
);
inventoryRouter.post(
  "/products",
  ...admin,
  validate({ body: createProductSchema }),
  productController.create,
);
inventoryRouter.get(
  "/products/:id",
  ...admin,
  validate({ params: productParamsSchema }),
  productController.getById,
);
inventoryRouter.patch(
  "/products/:id",
  ...admin,
  validate({ params: productParamsSchema, body: updateProductSchema }),
  productController.update,
);
inventoryRouter.delete(
  "/products/:id",
  ...admin,
  validate({ params: productParamsSchema }),
  productController.remove,
);

// ---------------------------------------------------------------------------
// Products: units (nested)
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/products/:productId/units",
  ...admin,
  validate({ params: productIdParamSchema }),
  unitController.listUnits,
);
inventoryRouter.post(
  "/products/:productId/units",
  ...admin,
  validate({ params: productIdParamSchema, body: createProductUnitSchema }),
  unitController.createUnit,
);
inventoryRouter.post(
  "/products/:productId/units/convert",
  ...admin,
  validate({ params: productIdParamSchema, body: convertUnitsSchema }),
  unitController.convert,
);
inventoryRouter.patch(
  "/products/:productId/units/:unitId",
  ...admin,
  validate({ params: unitParamsSchema, body: updateProductUnitSchema }),
  unitController.updateUnit,
);
inventoryRouter.delete(
  "/products/:productId/units/:unitId",
  ...admin,
  validate({ params: unitParamsSchema }),
  unitController.deleteUnit,
);

// ---------------------------------------------------------------------------
// Products: stock + batches + transactions (nested)
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/products/:productId/stock",
  ...admin,
  validate({ params: productIdParamSchema, query: productTransactionsQuerySchema }),
  stockController.productStock,
);
inventoryRouter.get(
  "/products/:productId/batches",
  ...admin,
  validate({ params: productIdParamSchema, query: batchListQuerySchema }),
  batchController.productBatches,
);
inventoryRouter.get(
  "/products/:productId/transactions",
  ...admin,
  validate({ params: productIdParamSchema, query: productTransactionsQuerySchema }),
  stockController.productTransactions,
);

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/batches",
  ...admin,
  validate({ query: batchListQuerySchema }),
  batchController.list,
);
inventoryRouter.post(
  "/batches",
  ...admin,
  validate({ body: createBatchSchema }),
  batchController.create,
);
inventoryRouter.get(
  "/batches/:id",
  ...admin,
  validate({ params: batchParamsSchema }),
  batchController.getById,
);
inventoryRouter.patch(
  "/batches/:id",
  ...admin,
  validate({ params: batchParamsSchema, body: updateBatchSchema }),
  batchController.update,
);
inventoryRouter.delete(
  "/batches/:id",
  ...admin,
  validate({ params: batchParamsSchema }),
  batchController.remove,
);

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/stock",
  ...admin,
  validate({ query: stockListQuerySchema }),
  stockController.listStock,
);
inventoryRouter.post(
  "/opening-stock",
  ...admin,
  validate({ body: openingStockSchema }),
  stockController.openingStock,
);
inventoryRouter.post(
  "/stock-adjustments",
  ...admin,
  validate({ body: stockAdjustmentSchema }),
  stockController.stockAdjustment,
);
