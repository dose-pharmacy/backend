import type { UserRole } from "../authorization/roles.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
  image: string | null;
};

export type AuthSession = {
  id: string;
  userId: string;
  expiresAt: Date;
};

export type RequestAuthContext = {
  user: AuthenticatedUser;
  session: AuthSession;
};
