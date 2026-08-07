import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The NATIVE app's auth transport, end to end over HTTP.
 *
 * The iOS app never holds a cookie: it takes the `token` out of the login JSON,
 * stores it, and sends `Authorization: Bearer` on every call. That whole path
 * had no test - the auth suite is cookie-only - so nothing caught a regression
 * that would lock every app user out while the web kept working.
 *
 * Also covers the /apple|google/link routes the app calls to connect a provider
 * to an account it just signed into with a password (see auth/native.ts). Their
 * token-verification half needs real Apple/Google JWTs, so what's asserted here
 * is the route contract: auth required, bad input rejected, unconfigured
 * providers reported as such rather than as a generic failure.
 */
const app = createApp();
const email = `native-http-${randomToken(6)}@test.local`.toLowerCase();
const password = "correct horse battery staple";
let token: string;
let userId: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Native HTTP", smsAttested: true });
  expect(signup.status).toBe(201);
  token = signup.body.token as string;
  userId = signup.body.id as string;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

describe("Bearer session (the app's transport)", () => {
  it("signup returns a token in the body for native callers", () => {
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
  });

  it("authenticates /api/auth/me with NO cookie, Bearer only", async () => {
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(userId);
    expect(me.body.email).toBe(email);
  });

  it("login returns a Bearer-usable token for a web-created account", async () => {
    // The exact flow behind "made my account on the web, signing in on iOS".
    const login = await request(app).post("/api/auth/login").send({ email, password });
    expect(login.status).toBe(200);
    const appToken = login.body.token as string;
    expect(typeof appToken).toBe("string");
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${appToken}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(userId);
  });

  it("rejects a garbage bearer and a missing header alike", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect(
      (await request(app).get("/api/auth/me").set("Authorization", "Bearer nonsense"))
        .status,
    ).toBe(401);
  });
});

describe("provider link routes", () => {
  it("require a session", async () => {
    const res = await request(app)
      .post("/api/auth/apple/link")
      .send({ identityToken: "x".repeat(40) });
    expect(res.status).toBe(401);
  });

  it("reject a malformed body", async () => {
    const res = await request(app)
      .post("/api/auth/google/link")
      .set("Authorization", `Bearer ${token}`)
      .send({ nope: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("report an unconfigured provider distinctly from a bad token", async () => {
    // With no APPLE_BUNDLE_ID / GOOGLE_OAUTH_IOS_CLIENT_ID set in the test env,
    // verification can't even be attempted - the app shows "not available right
    // now" instead of telling the barber their sign-in failed.
    const res = await request(app)
      .post("/api/auth/apple/link")
      .set("Authorization", `Bearer ${token}`)
      .send({ identityToken: "x".repeat(40) });
    expect([401, 503]).toContain(res.status);
    expect(
      res.status === 503 ? "apple_native_unconfigured" : "apple_token_invalid",
    ).toBe(res.body.error);
  });
});
