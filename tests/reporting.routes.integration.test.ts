import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";

/**
 * These endpoints must be registered AND stay behind the ADMIN guard. An
 * unauthenticated request therefore returns 401 — never 404 — which proves
 * both that the route exists and that authorisation is still enforced.
 */
describe("reporting routes", () => {
  let server: ReturnType<typeof app.listen>;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const getRoutes = [
    "/api/v1/financials/reports/sales/trend",
    "/api/v1/financials/reports/sales/summary",
    "/api/v1/financials/reports/sales/detail",
    "/api/v1/financials/reports/sales",
    "/api/v1/financials/reports/profitability/summary",
    "/api/v1/financials/reports/profitability",
    "/api/v1/financials/reports/profit-margin/summary",
    "/api/v1/financials/reports/profit-margin",
    "/api/v1/financials/reports/slow-moving",
  ];

  it.each(getRoutes)("registers GET %s behind authentication", async (path) => {
    const res = await request(server).get(path);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("registers POST /financials/slow-moving-configs/evaluate behind authentication", async () => {
    const res = await request(server).post(
      "/api/v1/financials/slow-moving-configs/evaluate",
    );
    expect(res.status).toBe(401);
  });
});
