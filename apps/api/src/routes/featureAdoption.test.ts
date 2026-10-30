import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { ADOPTION_FEATURES, __resetEnvCacheForTests, randomToken } from "@chairback/config";
import {
  __setFeatureAdoptionSourceForTests,
  type AdoptionTotals,
} from "../engines/featureAdoption.js";

/**
 * GET /api/insights/feature-adoption, with billing ENABLED (dummy STRIPE_*
 * set before the app is imported) so the plan flags are the real gate.
 * The platform totals come from a stub source: the shared test database
 * holds every suite's shops, and the totals themselves are covered in
 * engines/featureAdoption.test.ts. "You use this" is the real query.
 */

vi.mock("stripe", () => {
  class FakeStripe {
    customers = { create: async () => ({ id: `cus_adopt_${Date.now()}` }) };
  }
  return { default: FakeStripe, Stripe: FakeStripe };
});

const email = `adoption-route-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const DAY = 86_400_000;

let app: import("express").Express;
let cookie: string;
let shopId: string;

const TOTALS: AdoptionTotals = {
  pct: {
    online_booking: 85,
    rewards: 70,
    card_at_booking: 40,
    client_messages: 35,
    service_groups: 20,
    special_pricing: 15,
    custom_domain: 5,
    rebook_nudges: 60,
    waitlist: 25,
    auto_fill: 0,
  },
};
const source = vi.fn(async (): Promise<AdoptionTotals | null> => TOTALS);

async function setPlan(plan: "starter" | "pro") {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      plan,
      subscriptionStatus: "active",
      stripeSubscriptionId: `sub_adopt_${randomToken(8)}`,
      trialEndsAt: new Date(Date.now() - 30 * DAY),
      compAccess: false,
    },
  });
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_adopt_premium";
  process.env.STRIPE_STARTER_PRICE_ID = "price_adopt_starter";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_adopt";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Adoption Tester", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Adoption Shop", bookingUrl: "https://adoption.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  // This shop uses two features: rewards (any plan) and the waitlist (Premium).
  await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true, waitlistEnabled: true } });
});

beforeEach(() => {
  source.mockClear();
  __setFeatureAdoptionSourceForTests(source);
});

afterAll(async () => {
  __setFeatureAdoptionSourceForTests();
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_STARTER_PRICE_ID", "STRIPE_WEBHOOK_SECRET"]) {
    delete process.env[k];
  }
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

const get = () => request(app).get("/api/insights/feature-adoption").set("Cookie", cookie);

describe("the response", () => {
  beforeEach(() => setPlan("pro"));

  it("is exactly one row per feature, with exactly these fields", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["features"]);
    expect(res.body.features.map((r: { id: string }) => r.id)).toEqual(ADOPTION_FEATURES.map((f) => f.id));
    for (const row of res.body.features) {
      expect(Object.keys(row).sort()).toEqual(["href", "id", "inYourPlan", "label", "pct", "youUseIt"]);
      expect(typeof row.pct).toBe("number");
      expect(typeof row.youUseIt).toBe("boolean");
      expect(typeof row.inYourPlan).toBe("boolean");
      expect(row.href).toMatch(/^\/dashboard\//);
    }
  });

  it("carries the platform percentages and no shop's id, name or count", async () => {
    const res = await get();
    const byId = Object.fromEntries(res.body.features.map((r: { id: string; pct: number }) => [r.id, r.pct]));
    expect(byId).toEqual(TOTALS.pct);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(shopId);
    expect(json).not.toContain("Adoption Shop");
    expect(json).not.toMatch(/population|count|shopId|"shops"/i);
  });

  it("says which features THIS shop uses", async () => {
    const res = await get();
    const used = res.body.features.filter((r: { youUseIt: boolean }) => r.youUseIt).map((r: { id: string }) => r.id);
    expect(used.sort()).toEqual(["rewards", "waitlist"]);
  });

  it("below the privacy floor it is empty", async () => {
    source.mockResolvedValueOnce(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ features: [] });
  });
});

describe("plan flags", () => {
  const PREMIUM_ONLY = ADOPTION_FEATURES.filter((f) => f.gate === "premium").map((f) => f.id);

  it("Premium includes everything", async () => {
    await setPlan("pro");
    const res = await get();
    for (const row of res.body.features) expect(row.inYourPlan, row.id).toBe(true);
  });

  it("Starter includes the everyday features and not the Premium ones", async () => {
    await setPlan("starter");
    const res = await get();
    expect(res.status).toBe(200);
    for (const row of res.body.features) {
      expect(row.inYourPlan, row.id).toBe(!PREMIUM_ONLY.includes(row.id));
    }
    expect(PREMIUM_ONLY.sort()).toEqual(["auto_fill", "rebook_nudges", "waitlist"]);
  });

  it("'you use this' does not depend on the plan", async () => {
    await setPlan("starter");
    const res = await get();
    const waitlist = res.body.features.find((r: { id: string }) => r.id === "waitlist");
    expect(waitlist).toMatchObject({ youUseIt: true, inYourPlan: false });
  });
});

describe("cost", () => {
  beforeEach(() => setPlan("pro"));

  it("the platform totals are computed once, not on every request", async () => {
    await get();
    await get();
    await get();
    expect(source).toHaveBeenCalledTimes(1);
  });
});

describe("who may ask", () => {
  it("a signed-out caller is refused", async () => {
    const res = await request(app).get("/api/insights/feature-adoption");
    expect(res.status).toBe(401);
  });
});
