import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { genericProductController } from "../controllers/financials/generic-product.controller.js";
import { manufacturerController } from "../controllers/financials/manufacturer.controller.js";
import { discountAuthRuleController } from "../controllers/financials/discount-auth-rule.controller.js";
import { slowMovingConfigController } from "../controllers/financials/slow-moving.controller.js";
import { financialReportController } from "../controllers/financials/financial-report.controller.js";
import { narcoticReportController } from "../controllers/financials/narcotic-report.controller.js";
import { saleController } from "../controllers/financials/sale.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  createGenericProductSchema,
  updateGenericProductSchema,
  genericProductListQuerySchema,
  genericProductParamsSchema,
} from "../validators/financials/generic-product.js";
import {
  createManufacturerSchema,
  updateManufacturerSchema,
  manufacturerListQuerySchema,
  manufacturerParamsSchema,
} from "../validators/financials/manufacturer.js";
import {
  createDiscountAuthRuleSchema,
  updateDiscountAuthRuleSchema,
  discountAuthRuleListQuerySchema,
  discountAuthRuleParamsSchema,
} from "../validators/financials/discount-auth-rule.js";
import {
  createSlowMovingConfigSchema,
  updateSlowMovingConfigSchema,
  slowMovingConfigListQuerySchema,
  slowMovingConfigParamsSchema,
  slowMovingConfigProductParamsSchema,
} from "../validators/financials/slow-moving.js";
import {
  profitMarginReportQuerySchema,
  profitMarginSummaryQuerySchema,
  profitabilityReportQuerySchema,
  profitabilitySummaryQuerySchema,
  slowMovingReportQuerySchema,
  salesReportQuerySchema,
  salesSummaryQuerySchema,
  salesDetailQuerySchema,
  salesTrendQuerySchema,
} from "../validators/financials/reports.js";
import {
  narcoticReportQuerySchema,
  narcoticActivityQuerySchema,
} from "../validators/financials/narcotic-reports.js";
import {
  createSaleSchema,
  updateSaleSchema,
  saleListQuerySchema,
  saleParamsSchema,
  voidSaleSchema,
  saleDetailQuerySchema,
} from "../validators/financials/sale.js";

export const financialsRouter = Router();

// Only ADMIN may access financials in this phase.
const admin = [requireAuthenticatedUser, requireRole(UserRole.ADMIN)] as const;

// ---------------------------------------------------------------------------
// Generic Products
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/generic-products",
  ...admin,
  validate({ query: genericProductListQuerySchema }),
  genericProductController.list,
);
financialsRouter.post(
  "/generic-products",
  ...admin,
  validate({ body: createGenericProductSchema }),
  genericProductController.create,
);
financialsRouter.get(
  "/generic-products/:id",
  ...admin,
  validate({ params: genericProductParamsSchema }),
  genericProductController.getById,
);
financialsRouter.patch(
  "/generic-products/:id",
  ...admin,
  validate({ params: genericProductParamsSchema, body: updateGenericProductSchema }),
  genericProductController.update,
);
financialsRouter.delete(
  "/generic-products/:id",
  ...admin,
  validate({ params: genericProductParamsSchema }),
  genericProductController.remove,
);

// ---------------------------------------------------------------------------
// Manufacturers
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/manufacturers",
  ...admin,
  validate({ query: manufacturerListQuerySchema }),
  manufacturerController.list,
);
financialsRouter.post(
  "/manufacturers",
  ...admin,
  validate({ body: createManufacturerSchema }),
  manufacturerController.create,
);
financialsRouter.get(
  "/manufacturers/:id",
  ...admin,
  validate({ params: manufacturerParamsSchema }),
  manufacturerController.getById,
);
financialsRouter.patch(
  "/manufacturers/:id",
  ...admin,
  validate({ params: manufacturerParamsSchema, body: updateManufacturerSchema }),
  manufacturerController.update,
);
financialsRouter.delete(
  "/manufacturers/:id",
  ...admin,
  validate({ params: manufacturerParamsSchema }),
  manufacturerController.remove,
);

// ---------------------------------------------------------------------------
// Discount Authorization Rules
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/discount-auth-rules",
  ...admin,
  validate({ query: discountAuthRuleListQuerySchema }),
  discountAuthRuleController.list,
);
financialsRouter.post(
  "/discount-auth-rules",
  ...admin,
  validate({ body: createDiscountAuthRuleSchema }),
  discountAuthRuleController.create,
);
financialsRouter.get(
  "/discount-auth-rules/:id",
  ...admin,
  validate({ params: discountAuthRuleParamsSchema }),
  discountAuthRuleController.getById,
);
financialsRouter.patch(
  "/discount-auth-rules/:id",
  ...admin,
  validate({ params: discountAuthRuleParamsSchema, body: updateDiscountAuthRuleSchema }),
  discountAuthRuleController.update,
);
financialsRouter.delete(
  "/discount-auth-rules/:id",
  ...admin,
  validate({ params: discountAuthRuleParamsSchema }),
  discountAuthRuleController.remove,
);
financialsRouter.post(
  "/discount-auth-rules/check",
  ...admin,
  discountAuthRuleController.checkAuthorization,
);

// ---------------------------------------------------------------------------
// Slow Moving Configuration
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/slow-moving-configs",
  ...admin,
  validate({ query: slowMovingConfigListQuerySchema }),
  slowMovingConfigController.list,
);
financialsRouter.post(
  "/slow-moving-configs",
  ...admin,
  validate({ body: createSlowMovingConfigSchema }),
  slowMovingConfigController.create,
);
financialsRouter.get(
  "/slow-moving-configs/flagged",
  ...admin,
  slowMovingConfigController.getFlagged,
);
financialsRouter.post(
  "/slow-moving-configs/evaluate",
  ...admin,
  slowMovingConfigController.evaluate,
);
financialsRouter.get(
  "/slow-moving-configs/product/:productId",
  ...admin,
  validate({ params: slowMovingConfigProductParamsSchema }),
  slowMovingConfigController.getByProductId,
);
financialsRouter.get(
  "/slow-moving-configs/:id",
  ...admin,
  validate({ params: slowMovingConfigParamsSchema }),
  slowMovingConfigController.getById,
);
financialsRouter.patch(
  "/slow-moving-configs/:id",
  ...admin,
  validate({ params: slowMovingConfigParamsSchema, body: updateSlowMovingConfigSchema }),
  slowMovingConfigController.update,
);
financialsRouter.delete(
  "/slow-moving-configs/:id",
  ...admin,
  validate({ params: slowMovingConfigParamsSchema }),
  slowMovingConfigController.remove,
);

// ---------------------------------------------------------------------------
// Financial Reports
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/reports/sales/trend",
  ...admin,
  validate({ query: salesTrendQuerySchema }),
  financialReportController.getSalesTrend,
);
financialsRouter.get(
  "/reports/sales/summary",
  ...admin,
  validate({ query: salesSummaryQuerySchema }),
  financialReportController.getSalesSummary,
);
financialsRouter.get(
  "/reports/sales/detail",
  ...admin,
  validate({ query: salesDetailQuerySchema }),
  financialReportController.getSalesDetail,
);
financialsRouter.get(
  "/reports/sales",
  ...admin,
  validate({ query: salesReportQuerySchema }),
  financialReportController.getSalesReport,
);
financialsRouter.get(
  "/reports/profitability/summary",
  ...admin,
  validate({ query: profitabilitySummaryQuerySchema }),
  financialReportController.getProfitabilitySummary,
);
financialsRouter.get(
  "/reports/profitability",
  ...admin,
  validate({ query: profitabilityReportQuerySchema }),
  financialReportController.getProfitabilityReport,
);
financialsRouter.get(
  "/reports/profit-margin/summary",
  ...admin,
  validate({ query: profitMarginSummaryQuerySchema }),
  financialReportController.getProfitMarginSummary,
);
financialsRouter.get(
  "/reports/profit-margin",
  ...admin,
  validate({ query: profitMarginReportQuerySchema }),
  financialReportController.getProfitMarginReport,
);
financialsRouter.get(
  "/reports/slow-moving",
  ...admin,
  validate({ query: slowMovingReportQuerySchema }),
  financialReportController.getSlowMovingReport,
);

// ---------------------------------------------------------------------------
// Narcotic / Controlled Product Reports
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/reports/narcotics",
  ...admin,
  validate({ query: narcoticReportQuerySchema }),
  narcoticReportController.getNarcoticReport,
);
financialsRouter.get(
  "/reports/narcotics/activity",
  ...admin,
  validate({ query: narcoticActivityQuerySchema }),
  narcoticReportController.getNarcoticActivity,
);

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------
financialsRouter.get(
  "/sales",
  ...admin,
  validate({ query: saleListQuerySchema }),
  saleController.list,
);
financialsRouter.post(
  "/sales",
  ...admin,
  validate({ body: createSaleSchema }),
  saleController.create,
);
financialsRouter.get(
  "/sales/detail",
  ...admin,
  validate({ query: saleDetailQuerySchema }),
  saleController.getDetail,
);
financialsRouter.get(
  "/sales/:id",
  ...admin,
  validate({ params: saleParamsSchema }),
  saleController.getById,
);
financialsRouter.patch(
  "/sales/:id",
  ...admin,
  validate({ params: saleParamsSchema, body: updateSaleSchema }),
  saleController.update,
);
financialsRouter.post(
  "/sales/:id/void",
  ...admin,
  validate({ params: saleParamsSchema, body: voidSaleSchema }),
  saleController.voidSale,
);
