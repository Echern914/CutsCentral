import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * TIP POLICY: whether the price a customer sees already includes a tip.
 *
 * DISPLAY ONLY. The whole feature is one word on a booking page, and the only
 * way it can do harm is by saying something the barber did not say - so what
 * these lock is mostly the silence: a shop that has not chosen must look
 * exactly as it did before this column existed.
 */
const app = createApp();
const email = `tip-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let shopId: string;
let slug: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Tip Shop", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const created = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Tip Shop", bookingUrl: "https://tip.test", smsAttested: true });
  expect(created.status).toBe(201);
  const shop = await prisma.shop.findFirstOrThrow({ where: { owner: { email } } });
  shopId = shop.id;
  slug = shop.slug!;
  // The public shell only serves a shop whose page is on and is on native
  // booking; without this the slug 404s and every read below is vacuous.
  await prisma.shop.update({
    where: { id: shopId },
    data: { publicPageEnabled: true, bookingMode: "native" },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email } });
});

describe("the barber's setting", () => {
  it("starts as null - a shop that never chose has no policy invented for it", async () => {
    const res = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.tipPolicy).toBeNull();
  });

  it("saves both answers and reads them back", async () => {
    for (const value of ["not_included", "included"] as const) {
      const patch = await request(app)
        .patch("/api/payments/settings")
        .set("Cookie", cookie)
        .send({ tipPolicy: value });
      expect(patch.status).toBe(200);
      const res = await request(app).get("/api/payments/status").set("Cookie", cookie);
      expect(res.body.tipPolicy).toBe(value);
    }
  });

  it("🔴 can be taken back down to saying nothing", async () => {
    // A barber must be able to retract a claim about money as easily as they
    // made it. null is a real value here, not "field omitted".
    await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ tipPolicy: "included" });
    const patch = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ tipPolicy: null });
    expect(patch.status).toBe(200);
    const res = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(res.body.tipPolicy).toBeNull();
  });

  it("rejects an off-vocabulary value", async () => {
    const res = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ tipPolicy: "maybe" });
    expect(res.status).toBe(400);
  });

  it("🔴 does NOT require Stripe - a pay-at-the-chair shop can still say it", async () => {
    // The tip question is about the price on the page, not about who processes
    // the money. Gating this behind Connect would silence exactly the shops
    // most likely to be asked "do I tip?"
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.stripeConnectAccountId).toBeNull();
    const res = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ tipPolicy: "not_included" });
    expect(res.status).toBe(200);
  });
});

describe("what the booking page is told", () => {
  it("carries the policy through to the public shell", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { tipPolicy: "not_included" } });
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.tipPolicy).toBe("not_included");
  });

  it("🔴 sends null when the barber has not chosen, so the page says nothing", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { tipPolicy: null } });
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.body.shop.tipPolicy).toBeNull();
  });
});

describe("the database refuses anything off-vocabulary", () => {
  it("🔴 the CHECK is the backstop, not the zod schema", async () => {
    // The API validates, but the API is not the only writer this row will ever
    // have. Dropping Shop_tipPolicy_check makes this pass.
    await expect(
      prisma.$executeRaw`UPDATE "Shop" SET "tipPolicy" = 'gratuity_included' WHERE "id" = ${shopId}`,
    ).rejects.toThrow();
  });

  it("still allows NULL", async () => {
    await expect(
      prisma.$executeRaw`UPDATE "Shop" SET "tipPolicy" = NULL WHERE "id" = ${shopId}`,
    ).resolves.toBeDefined();
  });
});
