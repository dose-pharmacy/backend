import type { Request, Response } from "express";
import {
  requirementService,
  type CreateRequirementInput,
  type RequirementListQuery,
  type RequirementLinesByProductQuery,
  type RequirementLinesQuery,
  type UpdateRequirementInput,
  type AddRequirementLineInput,
  type UpdateRequirementLineInput,
} from "../../services/purchasing/requirement.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const requirementController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: RequirementListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      status: query.status as RequirementListQuery["status"],
      search: query.search,
    };
    const { items, meta, summary } = await requirementService.list(input);
    sendSuccess(res, items, { meta, summary });
  }),

  /**
   * Dedicated product-oriented requirement lines list endpoint.
   * Returns a flat list with one row per requirement line with summary quantities.
   */
  listLines: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const input: RequirementLinesQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      search: typeof query.search === "string" ? query.search : undefined,
      status: typeof query.status === "string" ? (query.status as any) : undefined,
      statuses: Array.isArray(query.statuses)
        ? (query.statuses as any)
        : typeof query.statuses === "string"
          ? (query.statuses.split(",").map((s) => s.trim()).filter(Boolean) as any)
          : undefined,
      sortBy: typeof query.sortBy === "string" ? (query.sortBy as any) : undefined,
      sortOrder: typeof query.sortOrder === "string" ? (query.sortOrder as any) : undefined,
    };
    const { items, meta, summary } = await requirementService.listRequirementLines(input);
    sendSuccess(res, items, { meta, summary });
  }),

  /**
   * Dedicated detail endpoint for a single purchase requirement line.
   * Includes linked purchase order history and parent requirement details.
   */
  getLineDetail: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.getRequirementLineDetail(req.params.lineId as string);
    sendSuccess(res, data);
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await requirementService.create(req.body as CreateRequirementInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  preview: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.preview(
      req.body as CreateRequirementInput,
      req.auth!.user,
    );
    sendSuccess(res, data, { status: 200 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  /** Requirement lines for one product (required amount + unit + amount created). */
  linesByProduct: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: RequirementLinesByProductQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      requirementId: query.requirementId,
      status: query.status as RequirementLinesByProductQuery["status"],
    };
    const data = await requirementService.listLinesByProduct(
      req.query.productId as string,
      input,
    );
    sendSuccess(res, data.items, { meta: data.meta });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.update(
      req.params.id as string,
      req.body as UpdateRequirementInput,
      req.auth?.user,
    );
    sendSuccess(res, data);
  }),

  close: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.close(req.params.id as string, req.auth?.user);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await requirementService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),

  addLine: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.addLine(
      req.params.id as string,
      req.body as AddRequirementLineInput,
    );
    sendSuccess(res, data, { status: 201 });
  }),

  updateLine: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.updateLine(
      req.params.lineId as string,
      req.body as UpdateRequirementLineInput,
    );
    sendSuccess(res, data);
  }),

  removeLine: asyncHandler(async (req: Request, res: Response) => {
    await requirementService.removeLine(req.params.lineId as string);
    sendSuccess(res, null);
  }),

  // Prefill payload used by the frontend to start a purchase order from a requirement
  // item. Never mutates state.
  getOrderPreview: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.getOrderPreview(req.params.lineId as string);
    sendSuccess(res, data);
  }),

  generateFromReorder: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await requirementService.generateFromReorder(actor);
    sendSuccess(res, data, { status: 201 });
  }),
};

