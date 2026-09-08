import { z } from "zod";
import {
  dateSchema,
  idParamSchema,
  moneySchema,
  optionalQueryString,
  paginationQuerySchema,
  requiredString,
  uuidSchema,
} from "./common.js";

const dateField = (label: string) =>
  dateSchema.refine((value) => !Number.isNaN(value.getTime()), `${label} must be a valid date`);

const fields = {
  batchNumber: requiredString(64, "Batch number"),
  manufacturingDate: dateField("Manufacturing date").optional(),
  receivedDate: dateField("Received date").optional(),
  expiryDate: dateField("Expiry date"),
  purchaseCost: moneySchema.optional(),
  supplierReference: z.string().trim().max(200).optional(),
};

export const createBatchSchema = z
  .object(fields)
  .extend({ productId: uuidSchema })
  .superRefine((value, ctx) => {
    if (value.manufacturingDate && value.expiryDate < value.manufacturingDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manufacturingDate"],
        message: "Manufacturing date must not be after the expiry date",
      });
    }
    if (value.receivedDate && value.expiryDate < value.receivedDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receivedDate"],
        message: "Received date must not be after the expiry date",
      });
    }
  });

export const updateBatchSchema = z
  .object({
    batchNumber: requiredString(64, "Batch number"),
    manufacturingDate: dateField("Manufacturing date").nullable().optional(),
    receivedDate: dateField("Received date").nullable().optional(),
    expiryDate: dateField("Expiry date").optional(),
    purchaseCost: moneySchema.nullable().optional(),
    supplierReference: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.manufacturingDate && value.expiryDate && value.expiryDate < value.manufacturingDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manufacturingDate"],
        message: "Manufacturing date must not be after the expiry date",
      });
    }
    if (value.receivedDate && value.expiryDate && value.expiryDate < value.receivedDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receivedDate"],
        message: "Received date must not be after the expiry date",
      });
    }
  });

export const batchListQuerySchema = z
  .object({
    productId: uuidSchema.optional(),
    search: optionalQueryString(64),
    expiresBefore: dateField("Expires before").optional(),
    expiresAfter: dateField("Expires after").optional(),
  })
  .merge(paginationQuerySchema);

export { idParamSchema as batchParamsSchema };
