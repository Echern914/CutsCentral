import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLANS, __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  MARKETING_SMS_KINDS,
  monthEndUtc,
  monthStartUtc,
  monthlySmsQuotaFor,
  monthlySmsUsed,
  remainingMonthlySms,
} from "./quota.js";

/**
 * Monthly SMS quota: pure tier mapping + the DB usage count. STRIPE_* env is
 * set BEFORE the suite so billingEnabled() is true for the DB-backed helpers
 * (each vitest file runs in its own worker, so this can't leak elsewhere).
 */

const NOW = new Date("2026-06-15T12:00:00Z");
const DAY = 86_400_000;

let userId: string;
let shopId: string;
let clientId: string;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  __resetEnvCacheForTests();

  const user = await prisma.user.create({
    data: { email: `quota-${randomToken(6)}@test.local`, passwordHash: "x", name: "Q" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Quota Shop",
      bookingUrl: "https://quota.test",
      webhookSecret: randomToken(),
      subscriptionStatus: "active",
      stripeSubscriptionId: `sub_test_${randomToken(6)}`,
      plan: "pro",
    },
  });
  shopId = shop.id;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `quota-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Q",
      phone: "+13025550199",
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const base = {
  plan: "free",
  subscriptionStatus: "none",
  trialEndsAt: null as Date | null,
  compAccess: false,
  receptionistCompAccess: false,
  receptionistSubscriptionStatus: "none",
};

describe("monthlySmsQuotaFor (pure)", () => {
  it("is unlimited while billing is disabled", () => {
    expect(monthlySmsQuotaFor(base, { enabled: false })).toBe(Infinity);
  });

  it("is 0 for a free / lapsed shop", () => {
    expect(monthlySmsQuotaFor(base, { now: NOW })).toBe(0);
    expect(
      monthlySmsQuotaFor(
        { ...base, subscriptionStatus: "canceled", trialEndsAt: new Date(NOW.getTime() - DAY) },
        { now: NOW },
      ),
    ).toBe(0);
  });

  it("gives Premium's quota to trials, comped shops, and active pro subs", () => {
    const trial = { ...base, trialEndsAt: new Date(NOW.getTime() + DAY) };
    const comped = { ...base, compAccess: true };
    const pro = { ...base, plan: "pro", subscriptionStatus: "active" };
    for (const shop of [trial, comped, pro]) {
      expect(monthlySmsQuotaFor(shop, { now: NOW })).toBe(PLANS.pro.smsMonthlyQuota);
    }
  });

  it("gives Premium AI's quota to pro_ai and to any receptionist entitlement", () => {
    const proAi = { ...base, plan: "pro_ai", subscriptionStatus: "active" };
    const addon = {
      ...base,
      plan: "pro",
      subscriptionStatus: "active",
      receptionistSubscriptionStatus: "active",
    };
    const pilot = { ...base, compAccess: true, receptionistCompAccess: true };
    for (const shop of [proAi, addon, pilot]) {
      expect(monthlySmsQuotaFor(shop, { now: NOW })).toBe(PLANS.pro_ai.smsMonthlyQuota);
    }
  });
});

describe("month window helpers", () => {
  it("computes UTC month boundaries", () => {
    expect(monthStartUtc(NOW).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(monthEndUtc(NOW).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // December -> January rollover.
    const dec = new Date("2026-12-31T23:59:59Z");
    expect(monthEndUtc(dec).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("monthlySmsUsed + remainingMonthlySms (DB)", () => {
  it("counts only SENT marketing SMS from the current UTC month", async () => {
    const mk = (over: Record<string, unknown>) => ({
      shopId,
      clientId,
      channel: "SMS" as const,
      status: "SENT" as const,
      kind: "nudge",
      createdAt: NOW,
      ...over,
    });
    await prisma.nudge.createMany({
      data: [
        // Counts: one of each marketing kind.
        ...MARKETING_SMS_KINDS.map((kind) => mk({ kind })),
        // Excluded: transactional kinds.
        mk({ kind: "loyalty" }),
        mk({ kind: "appointment" }),
        mk({ kind: "receptionist_reply" }),
        // Excluded: non-SMS channel, non-SENT statuses.
        mk({ channel: "WEB_PUSH" }),
        mk({ status: "PENDING" }),
        mk({ status: "FAILED" }),
        // Excluded: the month boundary - 1s before June 1 UTC vs exactly on it.
        mk({ createdAt: new Date("2026-05-31T23:59:59Z") }),
        mk({ createdAt: new Date("2026-06-01T00:00:00Z") }),
      ],
    });

    // 4 marketing kinds at NOW + the exactly-on-boundary June row.
    expect(await monthlySmsUsed(shopId, NOW)).toBe(MARKETING_SMS_KINDS.length + 1);
  });

  it("remaining = quota - used, clamped at 0 after a downgrade", async () => {
    const used = await monthlySmsUsed(shopId, NOW);
    expect(await remainingMonthlySms(shopId, NOW)).toBe(
      PLANS.pro.smsMonthlyQuota - used,
    );

    // Lapse the shop (quota 0): remaining clamps to 0, never negative.
    await prisma.shop.update({
      where: { id: shopId },
      data: { subscriptionStatus: "canceled", stripeSubscriptionId: null, plan: "free" },
    });
    expect(await remainingMonthlySms(shopId, NOW)).toBe(0);

    // Restore for any later cases.
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        subscriptionStatus: "active",
        stripeSubscriptionId: `sub_test_${randomToken(6)}`,
        plan: "pro",
      },
    });
  });

  it("an unknown shop has nothing remaining", async () => {
    expect(await remainingMonthlySms("shop_does_not_exist", NOW)).toBe(0);
  });
});
