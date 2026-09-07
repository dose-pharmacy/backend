export const UserRole = {
  ADMIN: "ADMIN",
  PHARMACIST: "PHARMACIST",
  CASHIER: "CASHIER",
  INVENTORY_MANAGER: "INVENTORY_MANAGER",
  MANAGER: "MANAGER",
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const CURRENT_APPLICATION_ROLES = [UserRole.ADMIN] as const;

export function isUserRole(value: string): value is UserRole {
  return Object.values(UserRole).includes(value as UserRole);
}

export function hasRequiredRole(
  userRole: UserRole,
  allowedRoles: readonly UserRole[],
): boolean {
  return allowedRoles.includes(userRole);
}
