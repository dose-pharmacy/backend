import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { posProductController } from "../controllers/pos/pos-product.controller.js";
import { saleController } from "../controllers/pos/sale.controller.js";
import { saleReturnController } from "../controllers/pos/sale-return.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { posProductListQuerySchema } from "../validators/pos/pos-product.js";
import {
  cancelSaleSchema,
  createSaleSchema,
  saleListQuerySchema,
  saleParamsSchema,
  addSalePaymentSchema,
} from "../validators/pos/sale.js";
import {
  createSaleReturnSchema,
  saleReturnListQuerySchema,
  saleReturnParamsSchema,
} from "../validators/pos/sale-return.js";

export const posRouter = Router();

// POS is used by the whole staff: cashiers at the till, and
// admins/managers/pharmacists reviewing or overriding sales.
const posStaff = [
  requireAuthenticatedUser,
  requireRole(
    UserRole.ADMIN,
    UserRole.MANAGER,
    UserRole.PHARMACIST,
    UserRole.CASHIER,
  ),
] as const;

// ---------------------------------------------------------------------------
// POS product selection
// ---------------------------------------------------------------------------
posRouter.get(
  "/products",
  ...posStaff,
  validate({ query: posProductListQuerySchema }),
  posProductController.list,
);

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------
posRouter.post(
  "/sales",
  ...posStaff,
  validate({ body: createSaleSchema }),
  saleController.create,
);
posRouter.get(
  "/sales",
  ...posStaff,
  validate({ query: saleListQuerySchema }),
  saleController.list,
);
posRouter.get(
  "/sales/:id",
  ...posStaff,
  validate({ params: saleParamsSchema }),
  saleController.getById,
);
posRouter.post(
  "/sales/:id/payments",
  ...posStaff,
  validate({ params: saleParamsSchema, body: addSalePaymentSchema }),
  saleController.addPayment,
);
posRouter.post(
  "/sales/:id/cancel",
  ...posStaff,
  validate({ params: saleParamsSchema, body: cancelSaleSchema }),
  saleController.cancel,
);

// ---------------------------------------------------------------------------
// Customer product returns
// ---------------------------------------------------------------------------
// A return never modifies the original sale: the completed sale stays
// historical truth and the return is recorded separately against the exact
// original sale item. The refund is computed by the backend from the original
// sale's financial values — no refund amount is ever accepted from the client.
posRouter.get(
  "/sales/:id/returns",
  ...posStaff,
  validate({ params: saleParamsSchema }),
  saleReturnController.getReturnInfo,
);
posRouter.post(
  "/sales/:id/returns",
  ...posStaff,
  validate({ params: saleParamsSchema, body: createSaleReturnSchema }),
  saleReturnController.create,
);
posRouter.get(
  "/returns",
  ...posStaff,
  validate({ query: saleReturnListQuerySchema }),
  saleReturnController.list,
);
posRouter.get(
  "/returns/:id",
  ...posStaff,
  validate({ params: saleReturnParamsSchema }),
  saleReturnController.getById,
);