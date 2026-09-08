import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { batchController } from "../controllers/inventory/batch.controller.js";
import { binCardController } from "../controllers/inventory/bin-card.controller.js";
import { dashboardController } from "../controllers/inventory/dashboard.controller.js";
import { expiryActionController } from "../controllers/inventory/expiry-action.controller.js";
import { expiryController } from "../controllers/inventory/expiry.controller.js";
import { inventoryProductController } from "../controllers/inventory/inventory-product.controller.js";
import { locationController } from "../controllers/inventory/location.controller.js";
import { locationStockController } from "../controllers/inventory/location-stock.controller.js";
import { productController } from "../controllers/inventory/product.controller.js";
import { productGroupController } from "../controllers/inventory/product-group.controller.js";
import { reorderController } from "../controllers/inventory/reorder.controller.js";
import { stockController } from "../controllers/inventory/stock.controller.js";
import { stockTransferController } from "../controllers/inventory/stock-transfer.controller.js";
import { unitController } from "../controllers/inventory/unit.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  batchListQuerySchema,
  batchParamsSchema,
  batchTransactionQuerySchema,
  createBatchSchema,
  updateBatchSchema,
} from "../validators/inventory/batch.js";
import { productIdParamSchema } from "../validators/inventory/common.js";
import {
  createLocationSchema,
  locationListQuerySchema,
  locationParamsSchema,
  locationStockQuerySchema,
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
  binCardQuerySchema,
  dashboardQuerySchema,
  expiryDashboardQuerySchema,
  inventoryProductListQuerySchema,
  reorderConfigSchema,
} from "../validators/inventory/dashboard.js";
import {
  openingStockSchema,
  productTransactionsQuerySchema,
  stockAdjustmentSchema,
  stockListQuerySchema,
} from "../validators/inventory/stock.js";
import {
  createTransferSchema,
  transferListQuerySchema,
  transferParamsSchema,
  updateTransferSchema,
} from "../validators/inventory/stock-transfer.js";
import {
  batchIdParamSchema,
  createExpiryActionSchema,
  expiryActionListQuerySchema,
} from "../validators/inventory/expiry-action.js";
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
// Inventory Dashboard
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/dashboard",
  ...admin,
  validate({ query: dashboardQuerySchema }),
  dashboardController.getDashboard,
);

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

// ---------------------------------------------------------------------------
// Inventory Products (with stock status)
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/inventory-products",
  ...admin,
  validate({ query: inventoryProductListQuerySchema }),
  inventoryProductController.list,
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
inventoryRouter.get(
  "/batches/:id/transactions",
  ...admin,
  validate({ params: batchParamsSchema, query: batchTransactionQuerySchema }),
  batchController.getTransactions,
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

// ---------------------------------------------------------------------------
// Location Stock View
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/location-stock",
  ...admin,
  validate({ query: locationStockQuerySchema }),
  locationStockController.list,
);

// ---------------------------------------------------------------------------
// Expiry Dashboard
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/expiry/dashboard",
  ...admin,
  validate({ query: expiryDashboardQuerySchema }),
  expiryController.getDashboard,
);
inventoryRouter.get(
  "/expiry/batches",
  ...admin,
  validate({ query: expiryDashboardQuerySchema }),
  expiryController.getBatchesByWindow,
);

// ---------------------------------------------------------------------------
// Expiry Actions
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/batches/:batchId/expiry-actions",
  ...admin,
  validate({ params: batchIdParamSchema, query: expiryActionListQuerySchema }),
  expiryActionController.list,
);
inventoryRouter.post(
  "/batches/:batchId/expiry-actions",
  ...admin,
  validate({ params: batchIdParamSchema, body: createExpiryActionSchema }),
  expiryActionController.create,
);

// ---------------------------------------------------------------------------
// Bin Card
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/bin-card",
  ...admin,
  validate({ query: binCardQuerySchema }),
  binCardController.getBinCard,
);

// ---------------------------------------------------------------------------
// Reorder Management
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/reorder/dashboard",
  ...admin,
  validate({ query: expiryDashboardQuerySchema }), // reuse pagination schema
  reorderController.getDashboard,
);
inventoryRouter.get(
  "/reorder/suggestions",
  ...admin,
  validate({ query: expiryDashboardQuerySchema }), // reuse pagination schema
  reorderController.getSuggestions,
);
inventoryRouter.get(
  "/products/:productId/reorder-config",
  ...admin,
  validate({ params: productIdParamSchema }),
  reorderController.getConfig,
);
inventoryRouter.put(
  "/products/:productId/reorder-config",
  ...admin,
  validate({ params: productIdParamSchema, body: reorderConfigSchema }),
  reorderController.upsertConfig,
);
inventoryRouter.post(
  "/reorder/generate-purchase-requirements",
  ...admin,
  reorderController.generatePurchaseRequirements,
);

// ---------------------------------------------------------------------------
// Stock Transfers
// ---------------------------------------------------------------------------
inventoryRouter.get(
  "/transfers",
  ...admin,
  validate({ query: transferListQuerySchema }),
  stockTransferController.list,
);
inventoryRouter.post(
  "/transfers",
  ...admin,
  validate({ body: createTransferSchema }),
  stockTransferController.create,
);
inventoryRouter.get(
  "/transfers/:id",
  ...admin,
  validate({ params: transferParamsSchema }),
  stockTransferController.getById,
);
inventoryRouter.patch(
  "/transfers/:id",
  ...admin,
  validate({ params: transferParamsSchema, body: updateTransferSchema }),
  stockTransferController.update,
);
inventoryRouter.post(
  "/transfers/:id/complete",
  ...admin,
  validate({ params: transferParamsSchema }),
  stockTransferController.complete,
);
inventoryRouter.post(
  "/transfers/:id/cancel",
  ...admin,
  validate({ params: transferParamsSchema }),
  stockTransferController.cancel,
);
