import { Router } from "express";
import { UserRole } from "../authorization/roles.js";
import { adminController } from "../controllers/admin.controller.js";
import {
  requireAuthenticatedUser,
  requireRole,
} from "../middleware/authorize.js";
import { inventoryRouter } from "./inventory.js";
import { purchasingRouter } from "./purchasing.js";
import { posRouter } from "./pos.js";

export const v1Router = Router();

v1Router.get(
  "/admin/test",
  requireAuthenticatedUser,
  requireRole(UserRole.ADMIN),
  adminController.test,
);

v1Router.use("/inventory", inventoryRouter);
v1Router.use("/purchasing", purchasingRouter);
v1Router.use("/pos", posRouter);
