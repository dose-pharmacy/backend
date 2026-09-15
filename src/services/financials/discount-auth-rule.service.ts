import { Prisma } from "@prisma/client";
import { AppError } from "../../errors/app-error.js";
import { ErrorCode } from "../../errors/error-codes.js";
import { prisma } from "../../database/prisma.js";
import { buildPaginationMeta, resolvePagination } from "../../utils/pagination.js";
import type { PageQuery } from "../../utils/pagination.js";

export type CreateDiscountAuthRuleInput = {
  scope: "ITEM" | "BILL";
  maxDiscountPct: number;
  roleRequiredAbove?: string | null;
  isActive?: boolean;
};

export type UpdateDiscountAuthRuleInput = Partial<CreateDiscountAuthRuleInput>;

export type DiscountAuthRuleListQuery = PageQuery & {
  scope?: "ITEM" | "BILL";
  isActive?: boolean;
};

async function assertRuleExists(id: string) {
  const rule = await prisma.discountAuthorizationRule.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!rule) {
    throw new AppError(404, ErrorCode.DISCOUNT_AUTH_RULE_NOT_FOUND, "Discount authorization rule not found");
  }
}

export const discountAuthRuleService = {
  async list(query: DiscountAuthRuleListQuery) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.DiscountAuthorizationRuleWhereInput = {
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.discountAuthorizationRule.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.discountAuthorizationRule.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(total, page, limit) };
  },

  async create(input: CreateDiscountAuthRuleInput) {
    return prisma.discountAuthorizationRule.create({
      data: {
        scope: input.scope,
        maxDiscountPct: input.maxDiscountPct,
        roleRequiredAbove: input.roleRequiredAbove,
        isActive: input.isActive ?? true,
      },
    });
  },

  async getById(id: string) {
    const rule = await prisma.discountAuthorizationRule.findUnique({
      where: { id },
    });
    if (!rule) {
      throw new AppError(404, ErrorCode.DISCOUNT_AUTH_RULE_NOT_FOUND, "Discount authorization rule not found");
    }
    return rule;
  },

  async update(id: string, input: UpdateDiscountAuthRuleInput) {
    await assertRuleExists(id);

    return prisma.discountAuthorizationRule.update({
      where: { id },
      data: input,
    });
  },

  async remove(id: string) {
    await assertRuleExists(id);
    await prisma.discountAuthorizationRule.delete({ where: { id } });
  },

  async getRuleForScope(scope: "ITEM" | "BILL") {
    const rule = await prisma.discountAuthorizationRule.findFirst({
      where: { scope, isActive: true },
      orderBy: { maxDiscountPct: "desc" },
    });
    return rule;
  },

  async checkDiscountAuthorization(scope: "ITEM" | "BILL", discountPct: number, userRole: string) {
    const rule = await this.getRuleForScope(scope);
    if (!rule) {
      return { authorized: true }; // No rule = no limit
    }

    if (discountPct <= rule.maxDiscountPct.toNumber()) {
      return { authorized: true };
    }

    if (rule.roleRequiredAbove && userRole === rule.roleRequiredAbove) {
      return { authorized: true };
    }

    return {
      authorized: false,
      maxAllowed: rule.maxDiscountPct,
      requiredRole: rule.roleRequiredAbove,
    };
  },
};