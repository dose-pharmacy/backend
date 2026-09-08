import type { Request, Response } from "express";
import { reorderService, type ReorderConfigInput, type ReorderDashboardQuery, type ReorderSuggestionsQuery } from "../../services/inventory/reorder.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const reorderController = {
  getConfig: asyncHandler(async (req: Request, res: Response) => {
    const config = await reorderService.getConfig(req.params.productId as string);
    if (!config) {
      sendSuccess(res, null, { status: 404 });
      return;
    }
    sendSuccess(res, config);
  }),

  upsertConfig: asyncHandler(async (req: Request, res: Response) => {
    const config = await reorderService.upsertConfig(req.params.productId as string, req.body as ReorderConfigInput);
    sendSuccess(res, config, { status: 201 });
  }),

  getDashboard: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ReorderDashboardQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      urgency: query.urgency as ReorderDashboardQuery["urgency"],
    };
    const result = await reorderService.getDashboard(input);
    sendSuccess(res, { items: result.items, summary: result.summary }, { meta: { page: query.page ? Number(query.page) : 1, limit: query.limit ? Number(query.limit) : 20, total: result.summary.totalItems, totalPages: Math.ceil(result.summary.totalItems / (query.limit ? Number(query.limit) : 20)) } });
  }),

  getSuggestions: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: ReorderSuggestionsQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    };
    const { items, meta } = await reorderService.getSuggestions(input);
    sendSuccess(res, items, { meta });
  }),

  generatePurchaseRequirements: asyncHandler(async (req: Request, res: Response) => {
    // Generate a lightweight purchase requirement draft
    const { items } = await reorderService.getSuggestions({ page: 1, limit: 1000 });

    const requirements = items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      productSku: item.productSku,
      suggestedQuantity: item.suggestedQuantity,
      calculationMethod: item.calculationMethod,
      currentStock: item.currentStock,
      reorderPoint: item.reorderPoint,
      leadTimeDays: item.leadTimeDays,
      status: "DRAFT",
    }));

    sendSuccess(res, { requirements, generatedAt: new Date() }, { status: 201 });
  }),
};