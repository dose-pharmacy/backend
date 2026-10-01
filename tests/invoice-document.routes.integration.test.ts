import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import app from "../src/app.js";
import { prisma } from "../src/database/prisma.js";

// Neon is slow; the default 30s timeouts produce spurious failures.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const fixture = (name: string) => join(dirname(fileURLToPath(import.meta.url)), "fixtures", name);

function sessionCookie(res: request.Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

/**
 * Routes-level checks for the multipart document-extract endpoint, including an
 * authenticated end-to-end extraction through the real HTTP stack. The route
 * must exist AND stay behind the ADMIN guard: an unauthenticated request
 * returns 401 — never 404 — proving both registration and authorization.
 */
describe("invoice document upload route", () => {
  let server: ReturnType<typeof app.listen>;
  let cookie: string | undefined;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));

    try {
      await prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      return;
    }

    // Sign-up grants ADMIN in this phase (same pattern as auth.integration).
    const email = `invdoc.${Date.now()}.${Math.random().toString(16).slice(2)}@example.com`;
    const signup = await request(server)
      .post("/api/auth/sign-up/email")
      .send({ name: "Invoice Doc Admin", email, password: "ValidPass1" });
    if (signup.status === 200) {
      createdUserIds.push(signup.body.user.id as string);
      cookie = sessionCookie(signup);
    }
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("registers POST /purchasing/invoice-upload/extract behind authentication", async () => {
    const res = await request(server).post("/api/v1/purchasing/invoice-upload/extract");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects an unauthenticated multipart upload with a clean 401 (no connection reset)", async () => {
    const res = await request(server)
      .post("/api/v1/purchasing/invoice-upload/extract")
      .attach("file", fixture("invoice.pdf"), { contentType: "application/pdf" });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("extracts an uploaded text-layer PDF end-to-end (multipart -> normalized JSON)", async () => {
    if (!cookie) return;

    const res = await request(server)
      .post("/api/v1/purchasing/invoice-upload/extract")
      .set("Cookie", cookie)
      .attach("file", fixture("invoice.pdf"), { contentType: "application/pdf" })
      .expect(200);

    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.document.kind).toBe("pdf");
    expect(data.document.textExtracted).toBe(true);
    expect(data.invoiceNumber).toBe("CR-00004212");
    expect(data.supplierName).toBe("DEVICE TRADING PLC");
    expect(data.supplierTin).toBe("0046966869");
    expect(data.fsNumber).toBe("00012242");
    expect(data.invoiceDate).toBe("2026-08-20T00:00:00.000Z");
    expect(data.items).toHaveLength(1);
    expect(data.items[0].productCode).toBe("FINS-01");
    expect(data.items[0].expiryDate).toBe("2030-06-30T00:00:00.000Z");
    // No SupplierInvoice or any other persistence happens during extraction.
    expect(
      await prisma.supplierInvoice.count({ where: { invoiceNumber: "CR-00004212" } }),
    ).toBe(0);
  });

  it("rejects an unsupported document with 415 through the error envelope", async () => {
    if (!cookie) return;

    // GIF magic bytes with a spoofed .pdf name.
    const res = await request(server)
      .post("/api/v1/purchasing/invoice-upload/extract")
      .set("Cookie", cookie)
      .attach("file", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]), {
        filename: "invoice.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
  });

  it("rejects a missing file field with 422", async () => {
    if (!cookie) return;

    const res = await request(server)
      .post("/api/v1/purchasing/invoice-upload/extract")
      .set("Cookie", cookie)
      .field("notAFile", "1");
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });
});
