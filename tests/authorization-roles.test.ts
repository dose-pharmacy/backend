import { describe, expect, it } from "vitest";
import {
  hasRequiredRole,
  isUserRole,
  UserRole,
} from "../src/authorization/roles.js";
import { hasPermission } from "../src/authorization/permissions.js";

describe("authorization roles", () => {
  it("recognizes ADMIN as a valid role", () => {
    expect(isUserRole("ADMIN")).toBe(true);
    expect(hasRequiredRole(UserRole.ADMIN, [UserRole.ADMIN])).toBe(true);
  });

  it("denies a future non-admin role", () => {
    expect(hasRequiredRole(UserRole.PHARMACIST, [UserRole.ADMIN])).toBe(false);
  });

  it("grants wildcard permissions only to ADMIN for now", () => {
    expect(hasPermission(UserRole.ADMIN, "inventory:read")).toBe(true);
    expect(hasPermission(UserRole.PHARMACIST, "inventory:read")).toBe(false);
  });
});
