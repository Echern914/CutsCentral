import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";

/**
 * The receptionist toggle requires the ENTITLEMENT. Before this gate a free
 * shop could PATCH receptionistEnabled:true (only the liability terms were
 * checked), the settings showed the AI as running, and nothing ever answered
 * a client's text — a silent, paid-looking failure.
 *
 * Billing must be ENABLED for the gate to bite (hasReceptionistEntitlement
 * returns true when Stripe env is unset), so this file uses billing.test.ts's
 * pattern: set dummy STRIPE_* env BEFORE dynamically importing the app. No
 * Stripe API call ever happens — nothing here reaches a checkout.
 */
const email = `rgate-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let app: import("express").Express;
let cookie: string;
let shopId: string;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Gate Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Gate Cuts", bookingUrl: "https://gate.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

function patchShop(body: Record<string, unknown>) {
  return request(app).patch("/api/shops/me").set("Cookie", cookie).send(body);
}

describe("receptionist toggle vs entitlement", () => {
  it("409s an un-entitled enable and stamps NOTHING", async () => {
    // A trialing shop has hasAccess but NOT the pro_ai entitlement — the
    // receptionist is the one feature the trial does not include.
    const res = await patchShop({
      receptionistEnabled: true,
      acceptReceptionistTerms: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("receptionist_not_entitled");
    const row = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { receptionistEnabled: true, receptionistTermsAcceptedAt: true },
    });
    // The early return must fire before the terms stamp: a rejected enable
    // that silently recorded the liability acceptance would be a lie in the
    // other direction.
    expect(row?.receptionistEnabled).toBe(false);
    expect(row?.receptionistTermsAcceptedAt).toBeNull();
  });

  it("entitled (comped add-on) enable works, terms and all", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { receptionistCompAccess: true },
    });
    const res = await patchShop({
      receptionistEnabled: true,
      acceptReceptionistTerms: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.receptionistEnabled).toBe(true);
    const row = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { receptionistTermsAcceptedAt: true },
    });
    expect(row?.receptionistTermsAcceptedAt).not.toBeNull();
  });

  it("disabling never needs the entitlement", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { receptionistCompAccess: false },
    });
    const res = await patchShop({ receptionistEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.receptionistEnabled).toBe(false);
  });

  it("unrelated PATCHes are untouched by the gate", async () => {
    const res = await patchShop({ bio: "Fades and tapers." });
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("Fades and tapers.");
  });
});
