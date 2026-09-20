import { AuditAction, AuditEntity, Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { resolvePagination, type PageQuery } from "../../utils/pagination.js";

export type AuditTrailQuery = PageQuery & {
  userId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
  startDate?: Date;
  endDate?: Date;
};

export type AuditTrailResult = {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string };
  action: string;
  entity: string;
  entityId: string;
  oldData: Prisma.JsonValue | null;
  newData: Prisma.JsonValue | null;
  description: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
};

export type AuditTrailPageResult = {
  data: AuditTrailResult[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export const auditTrailService = {
  async log(params: {
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    oldData?: Prisma.InputJsonValue;
    newData?: Prisma.InputJsonValue;
    description?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await prisma.auditTrail.create({
      data: {
        userId: params.userId,
        action: params.action as AuditAction,
        entity: params.entity as AuditEntity,
        entityId: params.entityId,
        oldData: params.oldData ?? Prisma.JsonNull,
        newData: params.newData ?? Prisma.JsonNull,
        description: params.description ?? null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    });
  },

  async getAuditTrail(query: AuditTrailQuery): Promise<AuditTrailPageResult> {
    const {
      userId,
      action,
      entity,
      entityId,
      startDate,
      endDate,
    } = query;

    const where: Prisma.AuditTrailWhereInput = {};

    if (userId) {
      where.userId = userId;
    }

    if (action) {
      where.action = action as AuditAction;
    }

    if (entity) {
      where.entity = entity as AuditEntity;
    }

    if (entityId) {
      where.entityId = entityId;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = startDate;
      }
      if (endDate) {
        where.createdAt.lte = endDate;
      }
    }

    const { skip, take, page, limit } = resolvePagination(query);

    const [data, total] = await prisma.$transaction([
      prisma.auditTrail.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),

      prisma.auditTrail.count({ where }),
    ]);

    return {
      data: data.map((item) => ({
        id: item.id,
        userId: item.userId,
        user: item.user,
        action: item.action,
        entity: item.entity,
        entityId: item.entityId,
        oldData: item.oldData,
        newData: item.newData,
        description: item.description,
        ipAddress: item.ipAddress,
        userAgent: item.userAgent,
        createdAt: item.createdAt,
      })),
      total,
      page,
      pageSize: limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  },

  async getAuditTrailByEntity(
    entity: string,
    entityId: string,
    query: PageQuery = {}
  ): Promise<AuditTrailPageResult> {
    return this.getAuditTrail({ ...query, entity, entityId });
  },

  async getAuditTrailByUser(
    userId: string,
    query: PageQuery = {}
  ): Promise<AuditTrailPageResult> {
    return this.getAuditTrail({ ...query, userId });
  },
};