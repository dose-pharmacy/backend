import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { posProductController } from "../controllers/pos/pos-product.controller.js";
import { saleController } from "../controllers/pos/sale.controller.js";
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
} from "../validators/pos/sale.js";

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
  "/sales/:id/cancel",
  ...posStaff,
  validate({ params: saleParamsSchema, body: cancelSaleSchema }),
  saleController.cancel,
);