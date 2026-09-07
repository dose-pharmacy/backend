import type { UserRole } from "../authorization/roles.js";
import { isUserRole, UserRole as Roles } from "../authorization/roles.js";
import { prisma } from "../database/prisma.js";
import { logger } from "../config/logger.js";
import type { AuthenticatedUser } from "../types/auth.js";

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
  image: string | null;
};

export const userRepository = {
  async findById(id: string): Promise<UserRecord | null> {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
        image: true,
      },
    });

    if (!user) {
      return null;
    }

    if (!isUserRole(user.role)) {
      logger.warn(
        { userId: id, role: user.role },
        "User has an unrecognised role in the database; treating as unauthenticated",
      );
      return null;
    }

    return {
      ...user,
      role: user.role,
    };
  },

  async updateRole(id: string, role: UserRole): Promise<void> {
    await prisma.user.update({
      where: { id },
      data: { role },
    });
  },
};

export function toAuthenticatedUser(user: UserRecord): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerified,
    image: user.image,
  };
}

export const DEFAULT_USER_ROLE = Roles.ADMIN;
