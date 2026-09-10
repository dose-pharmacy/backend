import type { Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { openApiDocument } from "../src/docs/openapi.js";
import { inventoryRouter } from "../src/routes/inventory.js";
import { posRouter } from "../src/routes/pos.js";

type Route = { method: string; path: string };

/**
 * Collects the literal routes registered on an Express router.
 * `prefix` is the mount path of the router (e.g. "/api/v1/inventory").
 */
function collectRoutes(router: Router, prefix: string): Route[] {
  const out: Route[] = [];
  for (const layer of router.stack) {
    if (!layer) continue;
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      out.push(...collectRoutes(layer.handle as Router, prefix));
    }
  }
  return out;
}

const normalize = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const realRoutes = [
  ...collectRoutes(inventoryRouter, "/api/v1/inventory"),
  ...collectRoutes(posRouter, "/api/v1/pos"),
];

describe("OpenAPI / Swagger documentation", () => {
  let server: ReturnType<typeof app.listen>;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the raw OpenAPI document at /api-docs", async () => {
    const res = await request(server).get("/api-docs").expect(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.info.title).toContain("Pharmacy");
    expect(typeof res.body.paths).toBe("object");
  });

  it("serves Swagger UI at /api-docs/ui", async () => {
    const res = await request(server).get("/api-docs/ui").expect(200);
    expect(res.text).toContain("swagger-ui");
  });

  it("documents every POS route that actually exists", () => {
    const posPaths = Object.keys(openApiDocument.paths).filter((path) => path.startsWith("/pos"));
    expect(posPaths.length).toBeGreaterThan(0);
    for (const path of posPaths) {
      for (const method of Object.keys(openApiDocument.paths[path])) {
        const route = realRoutes.find(
          (r) => r.method === method.toUpperCase() && normalize(r.path) === path,
        );
        expect(route, `${method.toUpperCase()} ${path} is documented but has no route`).toBeDefined();
      }
    }
  });

  it("documents every route that actually exists on inventory and POS routers", () => {
    const documented = (method: string, path: string) =>
      Object.keys(openApiDocument.paths).some((specPath) => {
        if (normalize(path) !== specPath) return false;
        return Object.keys(openApiDocument.paths[specPath]).includes(method.toLowerCase());
      });

    for (const route of realRoutes) {
      expect(
        documented(route.method, route.path),
        `${route.method} ${route.path} exists but is not documented`,
      ).toBe(true);
    }
  });
});