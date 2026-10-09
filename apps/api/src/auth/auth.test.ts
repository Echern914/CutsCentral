import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { createApp } from "../app.js";

const app = createApp();
const email = `auth-${Date.now()}@test.local`;
const password = "supersecret123";

afterAll(async () => {
  // Delete shops first (User->Shop has no cascade, by design), then the user.
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("barber auth flow", () => {
  let cookie: string;

  it("rejects signup with invalid input", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "not-an-email", password: "short", name: "" });
    expect(res.status).toBe(400);
  });

  it("signs up and sets an httpOnly session cookie", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password, name: "Test Barber", smsAttested: true });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    cookie = (setCookie as unknown as string[])[0]!;
    expect(cookie).toMatch(/cb_session=/);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("rejects a duplicate email with 409", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password, name: "Dupe", smsAttested: true });
    expect(res.status).toBe(409);
  });

  it("rejects signup without the SMS attestation", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: `noattest-${email}`, password, name: "No Attest" });
    expect(res.status).toBe(400);
  });

  it("rejects protected route without a cookie (401)", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("allows the protected route with the session cookie", async () => {
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
  });

  it("rejects login with a wrong password (generic 401)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "wrongpassword" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  it("logs in with correct credentials", async () => {
    const res = await request(app).post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
  });

  it("returns 404 from /api/shops/me before a shop exists", async () => {
    const res = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_shop");
  });

  it("creates a shop and reads it back scoped to the barber", async () => {
    const create = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Test Cuts", bookingUrl: "https://test.as.me", smsAttested: true });
    expect(create.status).toBe(201);
    expect(create.body.name).toBe("Test Cuts");
    // webhookSecret must NOT be exposed to the client.
    expect(create.body.webhookSecret).toBeUndefined();

    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.connected).toBe(false);
    expect(me.body.visitCount).toBe(0);
  });

  it("logs out (clears the cookie)", async () => {
    const res = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] as unknown as string[];
    expect(setCookie[0]).toMatch(/cb_session=;/);
  });
});

describe("signing out stops the booking alerts", () => {
  const otherEmail = `auth-other-${Date.now()}@test.local`;

  afterAll(async () => {
    const other = await prisma.user.findUnique({ where: { email: otherEmail } });
    if (other) {
      await prisma.shop.deleteMany({ where: { ownerId: other.id } });
      await prisma.user.delete({ where: { id: other.id } });
    }
  });

  it("🔴 drops the user's own devices - and only theirs", async () => {
    // A shared front-desk phone kept showing "new booking" alerts, with the
    // client's name, after the barber signed out in the app.
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherEmail, password, name: "Front Desk", smsAttested: true });
    const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Desk Cuts", smsAttested: true });
    const shopId = shop.body.id as string;
    const userId = signup.body.id as string;

    const suffix = Date.now();
    const registered = await request(app)
      .post("/api/barber/push/native")
      .set("Cookie", cookie)
      .send({ expoPushToken: `ExponentPushToken[desk-${suffix}]`, platform: "ios" });
    expect(registered.status).toBe(200);
    // A client's device at the same shop, and another barber's device, stay.
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `desk-${suffix}`, magicToken: `desk-${suffix}`, firstName: "Kept", source: "manual" },
    });
    await prisma.pushSubscription.create({
      data: { shopId, clientId: client.id, kind: "expo", expoPushToken: `ExponentPushToken[client-${suffix}]` },
    });
    const first = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.pushSubscription.create({
      data: { shopId, userId: first.id, kind: "expo", expoPushToken: `ExponentPushToken[other-${suffix}]` },
    });
    expect(await prisma.pushSubscription.count({ where: { userId } })).toBe(1);

    expect((await request(app).post("/api/auth/logout").set("Cookie", cookie)).status).toBe(200);

    expect(await prisma.pushSubscription.count({ where: { userId } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { clientId: client.id } })).toBe(1);
    expect(await prisma.pushSubscription.count({ where: { userId: first.id } })).toBe(1);
    await prisma.pushSubscription.deleteMany({ where: { userId: first.id } });
  });
});
