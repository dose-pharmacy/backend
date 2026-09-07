import { UserRole, type UserRole as Role } from "./roles.js";

/**
 * Placeholder permission model for a later phase.
 * Controllers should keep using requireRole today; this map is the
 * extension point for resource/action checks without rewriting routes.
 */
export type Permission = `${string}:${string}` | "*";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [UserRole.ADMIN]: ["*"],
  [UserRole.PHARMACIST]: [],
  [UserRole.CASHIER]: [],
  [UserRole.INVENTORY_MANAGER]: [],
  [UserRole.MANAGER]: [],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role];
  return granted.includes("*") || granted.includes(permission);
}
