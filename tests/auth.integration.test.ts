import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { UserRole } from "../src/authorization/roles.js";

function uniqueEmail(label: string): string {
  return `${label}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.com`;
}

function sessionCookie(res: request.Response): string | undefined {
  const cookies = res.headers["set-cookie"];
  if (!cookies) {
    return undefined;
  }
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return list.find((cookie) => cookie.startsWith("better-auth.session_token"));
}

describe("health", () => {
  it("GET /health reports liveness", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
    expect(JSON.stringify(res.body)).not.toMatch(/postgresql:\/\//i);
  });

  it("GET /health/ready checks the database", async () => {
    const res = await request(app).get("/health/ready");
    expect([200, 503]).toContain(res.status);
    expect(res.body.data.checks.database).toBeDefined();
    expect(JSON.stringify(res.body)).not.toMatch(/postgresql:\/\//i);
  });
});

describe("authentication", () => {
  const password = "ValidPass1";
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  it("registers a valid user and returns a session cookie", async () => {
    const email = uniqueEmail("register");
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Admin User", email, password })
      .expect(200);

    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.password).toBeUndefined();
    expect(sessionCookie(res)).toBeDefined();
    createdUserIds.push(res.body.user.id as string);
  });

  it("rejects an invalid email on registration", async () => {
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Bad Email", email: "not-an-email", password });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a short password on registration", async () => {
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({
        name: "Short Password",
        email: uniqueEmail("short"),
        password: "short",
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a duplicate account", async () => {
    const email = uniqueEmail("duplicate");
    const first = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "First", email, password })
      .expect(200);
    createdUserIds.push(first.body.user.id as string);

    const second = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Second", email, password });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
  });

  it("logs in with valid credentials", async () => {
    const email = uniqueEmail("login");
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Login User", email, password })
      .expect(200);
    createdUserIds.push(signup.body.user.id as string);

    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email, password })
      .expect(200);

    expect(res.body.user.email).toBe(email);
    expect(sessionCookie(res)).toBeDefined();
  });

  it("rejects invalid credentials", async () => {
    const email = uniqueEmail("badlogin");
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Bad Login", email, password })
      .expect(200);
    createdUserIds.push(signup.body.user.id as string);

    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email, password: "WrongPass1" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects login for a non-existent user", async () => {
    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: uniqueEmail("missing"), password });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("returns the current session when authenticated", async () => {
    const email = uniqueEmail("session");
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Session User", email, password })
      .expect(200);
    createdUserIds.push(signup.body.user.id as string);
    const cookie = sessionCookie(signup);
    expect(cookie).toBeDefined();

    const res = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", cookie as string)
      .expect(200);

    expect(res.body.user.email).toBe(email);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.token).toBeUndefined();
  });

  it("returns null for an unauthenticated session", async () => {
    const res = await request(app).get("/api/auth/get-session").expect(200);
    expect(res.body).toBeNull();
  });

  it("logs out and invalidates the session", async () => {
    const email = uniqueEmail("logout");
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Logout User", email, password })
      .expect(200);
    createdUserIds.push(signup.body.user.id as string);
    const cookie = sessionCookie(signup) as string;

    await request(app)
      .post("/api/auth/sign-out")
      .set("Cookie", cookie)
      .expect(200);

    const session = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", cookie)
      .expect(200);
    expect(session.body).toBeNull();
  });
});

describe("google oauth configuration", () => {
  it("exposes the Better Auth health endpoint", async () => {
    const res = await request(app).get("/api/auth/ok").expect(200);
    expect(res.body).toBeTruthy();
  });

  it("starts the Google OAuth redirect without using production credentials", async () => {
    expect(env.google.clientId.length).toBeGreaterThan(0);
    const res = await request(app)
      .get("/api/auth/sign-in/social")
      .query({ provider: "google", callbackURL: env.frontendUrl });

    expect([302, 307, 400, 422]).toContain(res.status);
    if (res.status === 302 || res.status === 307) {
      const location = res.headers.location as string;
      expect(location).toMatch(/accounts\.google\.com|google/);
      expect(location).not.toContain(env.google.clientSecret);
    }
  });
});

describe("authorization", () => {
  const password = "ValidPass1";
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    const email = uniqueEmail("admin-test");
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Authz User", email, password })
      .expect(200);
    userId = signup.body.user.id as string;
    cookie = sessionCookie(signup) as string;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns 401 without a session", async () => {
    const res = await request(app).get("/api/v1/admin/test").expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("allows ADMIN on the protected test endpoint", async () => {
    const res = await request(app)
      .get("/api/v1/admin/test")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.role).toBe(UserRole.ADMIN);
    expect(res.body.data.user.password).toBeUndefined();
  });

  it("returns 403 for a simulated future non-admin role", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.PHARMACIST },
    });

    const res = await request(app)
      .get("/api/v1/admin/test")
      .set("Cookie", cookie)
      .expect(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("FORBIDDEN");

    await prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.ADMIN },
    });
  });

  it("rejects unknown application routes with a safe error body", async () => {
    const res = await request(app).get("/api/v1/not-a-real-route").expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).not.toMatch(/prisma|stack|secret/i);
  });
});
