import type { Request, Response } from "express";
import {
  requirementService,
  type CreateRequirementInput,
  type RequirementListQuery,
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

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await requirementService.create(req.body as CreateRequirementInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.getById(req.params.id as string);
    sendSuccess(res, data);
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
