import type { Request, Response } from "express";
import { requirementService, type CreateRequirementInput, type RequirementListQuery, type UpdateRequirementInput, type AddRequirementLineInput, type UpdateRequirementLineInput, type AssignSupplierToLineInput } from "../../services/purchasing/requirement.service.js";
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
    const { items, meta } = await requirementService.list(input);
    sendSuccess(res, items, { meta });
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
    const data = await requirementService.update(req.params.id as string, req.body as UpdateRequirementInput);
    sendSuccess(res, data);
  }),

  close: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.close(req.params.id as string);
    sendSuccess(res, data);
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await requirementService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),

  addLine: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.addLine(req.params.id as string, req.body as AddRequirementLineInput);
    sendSuccess(res, data, { status: 201 });
  }),

  updateLine: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.updateLine(req.params.lineId as string, req.body as UpdateRequirementLineInput);
    sendSuccess(res, data);
  }),

  assignSupplier: asyncHandler(async (req: Request, res: Response) => {
    const data = await requirementService.assignSupplier(req.params.lineId as string, req.body as AssignSupplierToLineInput);
    sendSuccess(res, data);
  }),

  removeLine: asyncHandler(async (req: Request, res: Response) => {
    await requirementService.removeLine(req.params.lineId as string);
    sendSuccess(res, null);
  }),

  generateFromReorder: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await requirementService.generateFromReorder(actor);
    sendSuccess(res, data, { status: 201 });
  }),
};