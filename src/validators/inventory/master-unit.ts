import { z } from "zod";
import { optionalQueryString, paginationQuerySchema, requiredString } from "./common.js";

export const createMasterUnitSchema = z.object({
  name: requiredString(50, "Unit name"),
  symbol: z.string().trim().max(20).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

export const updateMasterUnitSchema = z
  .object({
    name: requiredString(50, "Unit name"),
    symbol: z.string().trim().max(20).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .partial();

export const masterUnitListQuerySchema = z
  .object({
    search: optionalQueryString(50),
    isActive: z.enum(["true", "false"]).optional(),
  })
  .merge(paginationQuerySchema);

export const masterUnitParamsSchema = z.object({
  id: z.string().uuid("Must be a valid UUID"),
});