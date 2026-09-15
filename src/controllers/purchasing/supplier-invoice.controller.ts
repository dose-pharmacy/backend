import type { Request, Response } from "express";
import { supplierInvoiceService, type CreateSupplierInvoiceInput, type SupplierInvoiceListQuery, type UpdateSupplierInvoiceInput, type RecordPaymentInput } from "../../services/purchasing/supplier-invoice.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/http.js";

export const supplierInvoiceController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, string | undefined>;
    const input: SupplierInvoiceListQuery = {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      supplierId: query.supplierId,
      status: query.status as SupplierInvoiceListQuery["status"],
      search: query.search,
    };
    const { items, meta } = await supplierInvoiceService.list(input);
    sendSuccess(res, items, { meta });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await supplierInvoiceService.create(req.body as CreateSupplierInvoiceInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await supplierInvoiceService.getById(req.params.id as string);
    sendSuccess(res, data);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await supplierInvoiceService.update(req.params.id as string, req.body as UpdateSupplierInvoiceInput);
    sendSuccess(res, data);
  }),

  recordPayment: asyncHandler(async (req: Request, res: Response) => {
    const actor = req.auth!.user;
    const data = await supplierInvoiceService.recordPayment(req.params.id as string, req.body as RecordPaymentInput, actor);
    sendSuccess(res, data, { status: 201 });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await supplierInvoiceService.remove(req.params.id as string);
    sendSuccess(res, null);
  }),
};