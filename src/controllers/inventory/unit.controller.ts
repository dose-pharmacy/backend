import type { Request, Response } from "express";
import { productUnitService } from "../../services/inventory/product-unit.service.js";
import type { CreateUnitInput, UpdateUnitInput } from "../../services/inventory/product-unit.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const unitController = {
  listUnits: asyncHandler(async (req: Request, res: Response) => {
    const data = await productUnitService.listUnits(req.params.productId as string);
    sendSuccess(res, data);
  }),

  createUnit: asyncHandler(async (req: Request, res: Response) => {
    const data = await productUnitService.createUnit(
      req.params.productId as string,
      req.body as CreateUnitInput,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  updateUnit: asyncHandler(async (req: Request, res: Response) => {
    const data = await productUnitService.updateUnit(
      req.params.productId as string,
      req.params.unitId as string,
      req.body as UpdateUnitInput,
    );
    sendSuccess(res, data);
  }),

  deleteUnit: asyncHandler(async (req: Request, res: Response) => {
    await productUnitService.deleteUnit(
      req.params.productId as string,
      req.params.unitId as string,
    );
    sendSuccess(res, null);
  }),

  convert: asyncHandler(async (req: Request, res: Response) => {
    const data = await productUnitService.convert(
      req.params.productId as string,
      req.body as { quantity: number; fromUnitId: string; toUnitId: string },
    );
    sendSuccess(res, data);
  }),
};
