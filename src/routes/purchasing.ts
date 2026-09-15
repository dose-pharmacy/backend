import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { supplierController } from "../controllers/purchasing/supplier.controller.js";
import { requirementController } from "../controllers/purchasing/requirement.controller.js";
import { purchaseOrderController } from "../controllers/purchasing/purchase-order.controller.js";
import { goodsReceiptController } from "../controllers/purchasing/goods-receipt.controller.js";
import { supplierInvoiceController } from "../controllers/purchasing/supplier-invoice.controller.js";
import { purchaseReturnController } from "../controllers/purchasing/purchase-return.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  createSupplierSchema,
  updateSupplierSchema,
  supplierListQuerySchema,
  supplierParamsSchema,
} from "../validators/purchasing/supplier.js";
import {
  createRequirementSchema,
  updateRequirementSchema,
  addRequirementLineSchema,
  updateRequirementLineSchema,
  assignSupplierToLineSchema,
  requirementListQuerySchema,
  requirementParamsSchema,
  requirementLineParamsSchema,
} from "../validators/purchasing/requirement.js";
import {
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  purchaseOrderListQuerySchema,
  purchaseOrderParamsSchema,
} from "../validators/purchasing/purchase-order.js";
import {
  createGoodsReceiptSchema,
  resolveGoodsReceiptSchema,
  goodsReceiptListQuerySchema,
  goodsReceiptParamsSchema,
} from "../validators/purchasing/goods-receipt.js";
import {
  createSupplierInvoiceSchema,
  updateSupplierInvoiceSchema,
  recordPaymentSchema,
  supplierInvoiceListQuerySchema,
  supplierInvoiceParamsSchema,
} from "../validators/purchasing/supplier-invoice.js";
import {
  createPurchaseReturnSchema,
  purchaseReturnListQuerySchema,
  purchaseReturnParamsSchema,
} from "../validators/purchasing/purchase-return.js";

export const purchasingRouter = Router();

// Only ADMIN may access purchasing in this phase.
const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
purchasingRouter.get(
  "/suppliers",
  ...admin,
  validate({ query: supplierListQuerySchema }),
  supplierController.list,
);
purchasingRouter.post(
  "/suppliers",
  ...admin,
  validate({ body: createSupplierSchema }),
  supplierController.create,
);
purchasingRouter.get(
  "/suppliers/:id",
  ...admin,
  validate({ params: supplierParamsSchema }),
  supplierController.getById,
);
purchasingRouter.patch(
  "/suppliers/:id",
  ...admin,
  validate({ params: supplierParamsSchema, body: updateSupplierSchema }),
  supplierController.update,
);
purchasingRouter.delete(
  "/suppliers/:id",
  ...admin,
  validate({ params: supplierParamsSchema }),
  supplierController.remove,
);

// ---------------------------------------------------------------------------
// Purchase Requirements
// ---------------------------------------------------------------------------
purchasingRouter.get(
  "/requirements",
  ...admin,
  validate({ query: requirementListQuerySchema }),
  requirementController.list,
);
purchasingRouter.post(
  "/requirements",
  ...admin,
  validate({ body: createRequirementSchema }),
  requirementController.create,
);
purchasingRouter.post(
  "/requirements/generate-from-reorder",
  ...admin,
  requirementController.generateFromReorder,
);
purchasingRouter.get(
  "/requirements/:id",
  ...admin,
  validate({ params: requirementParamsSchema }),
  requirementController.getById,
);
purchasingRouter.patch(
  "/requirements/:id",
  ...admin,
  validate({ params: requirementParamsSchema, body: updateRequirementSchema }),
  requirementController.update,
);
purchasingRouter.post(
  "/requirements/:id/close",
  ...admin,
  validate({ params: requirementParamsSchema }),
  requirementController.close,
);
purchasingRouter.delete(
  "/requirements/:id",
  ...admin,
  validate({ params: requirementParamsSchema }),
  requirementController.remove,
);

// Requirement Lines
purchasingRouter.post(
  "/requirements/:id/lines",
  ...admin,
  validate({ params: requirementParamsSchema, body: addRequirementLineSchema }),
  requirementController.addLine,
);
purchasingRouter.patch(
  "/requirements/lines/:lineId",
  ...admin,
  validate({ params: requirementLineParamsSchema, body: updateRequirementLineSchema }),
  requirementController.updateLine,
);
purchasingRouter.post(
  "/requirements/lines/:lineId/assign-supplier",
  ...admin,
  validate({ params: requirementLineParamsSchema, body: assignSupplierToLineSchema }),
  requirementController.assignSupplier,
);
purchasingRouter.delete(
  "/requirements/lines/:lineId",
  ...admin,
  validate({ params: requirementLineParamsSchema }),
  requirementController.removeLine,
);

// ---------------------------------------------------------------------------
// Purchase Orders
// ---------------------------------------------------------------------------
purchasingRouter.get(
  "/purchase-orders",
  ...admin,
  validate({ query: purchaseOrderListQuerySchema }),
  purchaseOrderController.list,
);
purchasingRouter.post(
  "/purchase-orders",
  ...admin,
  validate({ body: createPurchaseOrderSchema }),
  purchaseOrderController.create,
);
purchasingRouter.get(
  "/purchase-orders/:id",
  ...admin,
  validate({ params: purchaseOrderParamsSchema }),
  purchaseOrderController.getById,
);
purchasingRouter.patch(
  "/purchase-orders/:id",
  ...admin,
  validate({ params: purchaseOrderParamsSchema, body: updatePurchaseOrderSchema }),
  purchaseOrderController.update,
);
purchasingRouter.post(
  "/purchase-orders/:id/cancel",
  ...admin,
  validate({ params: purchaseOrderParamsSchema }),
  purchaseOrderController.cancel,
);
purchasingRouter.post(
  "/purchase-orders/:id/mark-delivered",
  ...admin,
  validate({ params: purchaseOrderParamsSchema }),
  purchaseOrderController.markDelivered,
);
purchasingRouter.post(
  "/purchase-orders/:id/close",
  ...admin,
  validate({ params: purchaseOrderParamsSchema }),
  purchaseOrderController.close,
);

// ---------------------------------------------------------------------------
// Goods Receipts (nested under purchase orders)
// ---------------------------------------------------------------------------
purchasingRouter.get(
  "/goods-receipts",
  ...admin,
  validate({ query: goodsReceiptListQuerySchema }),
  goodsReceiptController.list,
);
purchasingRouter.post(
  "/purchase-orders/:id/goods-receipts",
  ...admin,
  validate({ params: purchaseOrderParamsSchema, body: createGoodsReceiptSchema }),
  goodsReceiptController.create,
);
purchasingRouter.get(
  "/goods-receipts/:id",
  ...admin,
  validate({ params: goodsReceiptParamsSchema }),
  goodsReceiptController.getById,
);
purchasingRouter.patch(
  "/goods-receipts/:id/resolve",
  ...admin,
  validate({ params: goodsReceiptParamsSchema, body: resolveGoodsReceiptSchema }),
  goodsReceiptController.resolve,
);
purchasingRouter.post(
  "/goods-receipts/:id/confirm",
  ...admin,
  validate({ params: goodsReceiptParamsSchema }),
  goodsReceiptController.confirm,
);
purchasingRouter.delete(
  "/goods-receipts/:id",
  ...admin,
  validate({ params: goodsReceiptParamsSchema }),
  goodsReceiptController.remove,
);

// ---------------------------------------------------------------------------
// Supplier Invoices
// ---------------------------------------------------------------------------
purchasingRouter.get(
  "/supplier-invoices",
  ...admin,
  validate({ query: supplierInvoiceListQuerySchema }),
  supplierInvoiceController.list,
);
purchasingRouter.post(
  "/supplier-invoices",
  ...admin,
  validate({ body: createSupplierInvoiceSchema }),
  supplierInvoiceController.create,
);
purchasingRouter.get(
  "/supplier-invoices/:id",
  ...admin,
  validate({ params: supplierInvoiceParamsSchema }),
  supplierInvoiceController.getById,
);
purchasingRouter.patch(
  "/supplier-invoices/:id",
  ...admin,
  validate({ params: supplierInvoiceParamsSchema, body: updateSupplierInvoiceSchema }),
  supplierInvoiceController.update,
);
purchasingRouter.post(
  "/supplier-invoices/:id/payments",
  ...admin,
  validate({ params: supplierInvoiceParamsSchema, body: recordPaymentSchema }),
  supplierInvoiceController.recordPayment,
);
purchasingRouter.delete(
  "/supplier-invoices/:id",
  ...admin,
  validate({ params: supplierInvoiceParamsSchema }),
  supplierInvoiceController.remove,
);

// ---------------------------------------------------------------------------
// Purchase Returns
// ---------------------------------------------------------------------------
purchasingRouter.get(
  "/purchase-returns",
  ...admin,
  validate({ query: purchaseReturnListQuerySchema }),
  purchaseReturnController.list,
);
purchasingRouter.post(
  "/purchase-returns",
  ...admin,
  validate({ body: createPurchaseReturnSchema }),
  purchaseReturnController.create,
);
purchasingRouter.get(
  "/purchase-returns/:id",
  ...admin,
  validate({ params: purchaseReturnParamsSchema }),
  purchaseReturnController.getById,
);
purchasingRouter.delete(
  "/purchase-returns/:id",
  ...admin,
  validate({ params: purchaseReturnParamsSchema }),
  purchaseReturnController.remove,
);