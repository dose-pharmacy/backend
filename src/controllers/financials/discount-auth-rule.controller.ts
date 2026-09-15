import type { Request, Response } from "express";
import { discountAuthRuleService, type CreateDiscountAuthRuleInput, type DiscountAuthRuleListQuery, type UpdateDiscountAuthRuleInput } from "../../services/financials/discount-auth-rule.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const discountAuthRuleController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: DiscountAuthRuleListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      scope: query.scope as "ITEM" | "BILL" | undefined,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
    };
    const { items, meta } = await discountAuthRuleService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await discountAuthRuleService.create(req.body as CreateDiscountAuthRuleInput);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await discountAuthRuleService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await discountAuthRuleService.update(req.params.id as string, req.body as UpdateDiscountAuthRuleInput);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await discountAuthRuleService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),

  checkAuthorization: asyncHandler(async (req: Request, res: Response) => {
    const { scope, discountPct, userRole } = req.body;
    const result = await discountAuthRuleService.checkDiscountAuthorization(scope, discountPct, userRole);
    sendSuccess(res, result);
  }),
};