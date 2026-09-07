import type { RequestAuthContext } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuthContext;
    }
  }
}

export {};
