import { isDatabaseReady } from "../database/prisma.js";

export const healthService = {
  liveness() {
    return {
      status: "ok" as const,
    };
  },

  async readiness() {
    const database = await isDatabaseReady();
    return {
      status: database ? ("ready" as const) : ("unavailable" as const),
      checks: {
        database: database ? ("ok" as const) : ("fail" as const),
      },
    };
  },
};
