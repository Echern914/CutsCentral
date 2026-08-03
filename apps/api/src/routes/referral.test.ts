import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, REFERRAL } from "@chairback/config";
import { createApp } from "../app.js";
import { applyStripeEvent } from "../billing/stripe.js";
import { ensureReferralCode } from "../services/referral.js";

/**
 * Referral program end to end.
 *
 * The load-bearing property is that the REFERRER is paid only when the friend's
 * money actually clears. Most of these tests exist to pin that down from the
 * other direction: signing up, entering checkout, or a $0 trial invoice must
 * all leave the referrer with nothing, because each of those is farmable with
 * throwaway accounts.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

const DAY = 86_400_000;
const REWARD_MS = REFERRAL.rewardDays * DAY;

/** Signup + shop in one go. `ref` simulates arriving via a referral link. */
async function newShop(
  label: string,
  ref?: string,
): Promise<{ cookie: string; shopId: string; userId: string; email: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({
      email,
      password,
      name: label,
      smsAttested: true,
      // The web middleware captures ?ref into a cookie and signup persists it
      // here; passing it directly is the same code path the browser exercises.
      ...(ref ? { referralCode: ref } : {}),
    });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `${label} Cuts`, smsAttested: true });
  expect(shop.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie, shopId: shop.body.id, userId: user!.id, email };
}

/** Days of trial remaining, rounded, for readable assertions. */
async function trialDaysLeft(shopId: string): Promise<number> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { trialEndsAt: true },
  });
  if (!shop?.trialEndsAt) return 0;
  return Math.round((shop.trialEndsAt.getTime() - Date.now()) / DAY);
}

/** A paid invoice for a customer, as Stripe would deliver it. */
function invoicePaid(customerId: string, amountPaid = 3499) {
  return {
    type: "invoice.paid",
    data: { object: { customer: customerId, amount_paid: amountPaid } },
  } as never;
}

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("referral: attribution at signup", () => {
  it("gives the FRIEND an extra month immediately, and leaves the referrer pending", async () => {
    const referrer = await newShop("ref-a");
    const code = await ensureReferralCode(referrer.shopId);
    expect(code).toBeTruthy();

    const plainTrial = await trialDaysLeft(referrer.shopId);

    const friend = await newShop("friend-a", code!);
    // The friend's side of the deal lands right away: standard trial + a month.
    expect(await trialDaysLeft(friend.shopId)).toBe(plainTrial + REFERRAL.rewardDays);

    const row = await prisma.referral.findUnique({
      where: { referredShopId: friend.shopId },
    });
    expect(row?.status).toBe("PENDING");
    expect(row?.referrerShopId).toBe(referrer.shopId);

    // ...but the referrer has been given NOTHING yet. This is the whole point:
    // a signup is not revenue, and paying here is farmable with throwaway
    // emails.
    expect(await trialDaysLeft(referrer.shopId)).toBe(plainTrial);
    expect(row?.rewardedAt).toBeNull();
  });

  it("ignores an unknown code without failing shop creation", async () => {
    const friend = await newShop("friend-unknown", "not-a-real-code");
    expect(friend.shopId).toBeTruthy();
    const row = await prisma.referral.findUnique({
      where: { referredShopId: friend.shopId },
    });
    expect(row).toBeNull();
    // No phantom reward for a typo'd link.
    expect(await trialDaysLeft(friend.shopId)).toBe(REFERRAL.rewardDays);
  });

  it("voids a self-referral and grants no extra trial", async () => {
    const owner = await newShop("ref-self");
    const code = await ensureReferralCode(owner.shopId);

    // POST /api/shops refuses a second shop per user today (409), so the
    // second shop is created directly. The guard still has to exist: Shop is
    // already modelled as many-per-owner ("one today; FK clean for N later"),
    // and the day that opens up, a user's own link must not pay them.
    const second = await prisma.shop.create({
      data: {
        ownerId: owner.userId,
        name: "Self Cuts 2",
        webhookSecret: randomToken(),
        trialEndsAt: new Date(Date.now() + REFERRAL.rewardDays * DAY),
      },
    });

    const { linkReferralOnShopCreate } = await import("../services/referral.js");
    const linked = await linkReferralOnShopCreate({
      shopId: second.id,
      ownerId: owner.userId,
      code,
    });
    expect(linked).toBe(false);

    const row = await prisma.referral.findUnique({
      where: { referredShopId: second.id },
    });
    // Recorded, not silently dropped, so it's visible in the data.
    expect(row?.status).toBe("VOID");
    // And no trial was handed out for it.
    expect(await trialDaysLeft(second.id)).toBe(REFERRAL.rewardDays);

    // A VOID row can never be turned into a payout by a later invoice.
    const customerId = `cus_${randomToken(6)}`;
    await prisma.shop.update({
      where: { id: second.id },
      data: { stripeCustomerId: customerId },
    });
    const beforeOwnerTrial = await trialDaysLeft(owner.shopId);
    await applyStripeEvent(invoicePaid(customerId));
    expect(await trialDaysLeft(owner.shopId)).toBe(beforeOwnerTrial);
  });
});

describe("referral: the referrer is paid only on cleared money", () => {
  it("pays a not-yet-subscribed referrer with a trial month when the friend's invoice clears", async () => {
    const referrer = await newShop("ref-b");
    const code = await ensureReferralCode(referrer.shopId);
    const friend = await newShop("friend-b", code!);

    const before = await trialDaysLeft(referrer.shopId);

    // The friend's card is charged for real.
    const customerId = `cus_${randomToken(6)}`;
    await prisma.shop.update({
      where: { id: friend.shopId },
      data: { stripeCustomerId: customerId },
    });
    await applyStripeEvent(invoicePaid(customerId));

    expect(await trialDaysLeft(referrer.shopId)).toBe(before + REFERRAL.rewardDays);
    const row = await prisma.referral.findUnique({
      where: { referredShopId: friend.shopId },
    });
    expect(row?.status).toBe("REWARDED");
    expect(row?.rewardKind).toBe("trial_extension");
    expect(row?.rewardedAt).not.toBeNull();
    expect(row?.qualifiedAt).not.toBeNull();
  });

  it("does not pay twice when Stripe replays the same invoice", async () => {
    const referrer = await newShop("ref-c");
    const code = await ensureReferralCode(referrer.shopId);
    const friend = await newShop("friend-c", code!);

    const before = await trialDaysLeft(referrer.shopId);
    const customerId = `cus_${randomToken(6)}`;
    await prisma.shop.update({
      where: { id: friend.shopId },
      data: { stripeCustomerId: customerId },
    });

    // Stripe redelivers for up to ~3 days, and renewals fire this event every
    // month. Both must be harmless.
    await applyStripeEvent(invoicePaid(customerId));
    await applyStripeEvent(invoicePaid(customerId));
    await applyStripeEvent(invoicePaid(customerId));

    expect(await trialDaysLeft(referrer.shopId)).toBe(before + REFERRAL.rewardDays);
  });

  it("a $0 trial invoice does not qualify", async () => {
    const referrer = await newShop("ref-d");
    const code = await ensureReferralCode(referrer.shopId);
    const friend = await newShop("friend-d", code!);

    const before = await trialDaysLeft(referrer.shopId);
    const customerId = `cus_${randomToken(6)}`;
    await prisma.shop.update({
      where: { id: friend.shopId },
      data: { stripeCustomerId: customerId },
    });

    // Stripe issues a $0 invoice when a trial period starts. No money moved.
    await applyStripeEvent(invoicePaid(customerId, 0));

    expect(await trialDaysLeft(referrer.shopId)).toBe(before);
    const row = await prisma.referral.findUnique({
      where: { referredShopId: friend.shopId },
    });
    expect(row?.status).toBe("PENDING");
  });

  it("entering checkout is not enough - only a cleared invoice pays out", async () => {
    const referrer = await newShop("ref-e");
    const code = await ensureReferralCode(referrer.shopId);
    const friend = await newShop("friend-e", code!);
    const before = await trialDaysLeft(referrer.shopId);

    const customerId = `cus_${randomToken(6)}`;
    const subId = `sub_${randomToken(6)}`;
    // The friend completes checkout and their subscription goes live on a
    // trial. A card exists; nothing has been charged.
    await applyStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          client_reference_id: friend.shopId,
          customer: customerId,
          subscription: subId,
          metadata: { tier: "pro" },
        },
      },
    } as never);

    expect(await trialDaysLeft(referrer.shopId)).toBe(before);
    const row = await prisma.referral.findUnique({
      where: { referredShopId: friend.shopId },
    });
    expect(row?.status).toBe("PENDING");
  });
});

describe("referral: the dashboard page", () => {
  it("mints a stable code and reports what it has driven", async () => {
    const referrer = await newShop("ref-f");

    const first = await request(app)
      .get("/api/dashboard/referrals")
      .set("Cookie", referrer.cookie);
    expect(first.status).toBe(200);
    expect(first.body.code).toBeTruthy();
    expect(first.body.referrals).toEqual([]);
    expect(first.body.earnedMonths).toBe(0);

    // A code must never change once shared - a second view returns the same one.
    const second = await request(app)
      .get("/api/dashboard/referrals")
      .set("Cookie", referrer.cookie);
    expect(second.body.code).toBe(first.body.code);

    const friend = await newShop("friend-f", first.body.code);
    const withPending = await request(app)
      .get("/api/dashboard/referrals")
      .set("Cookie", referrer.cookie);
    expect(withPending.body.referrals).toHaveLength(1);
    expect(withPending.body.referrals[0].status).toBe("PENDING");
    expect(withPending.body.pendingCount).toBe(1);
    expect(withPending.body.earnedMonths).toBe(0);

    const customerId = `cus_${randomToken(6)}`;
    await prisma.shop.update({
      where: { id: friend.shopId },
      data: { stripeCustomerId: customerId },
    });
    await applyStripeEvent(invoicePaid(customerId));

    const withEarned = await request(app)
      .get("/api/dashboard/referrals")
      .set("Cookie", referrer.cookie);
    expect(withEarned.body.earnedMonths).toBe(1);
    expect(withEarned.body.pendingCount).toBe(0);
    expect(withEarned.body.referrals[0].rewardedAt).not.toBeNull();
  });

  it("one shop cannot see another's referrals", async () => {
    const a = await newShop("ref-g");
    const b = await newShop("ref-h");
    const codeA = await ensureReferralCode(a.shopId);
    await newShop("friend-g", codeA!);

    const res = await request(app)
      .get("/api/dashboard/referrals")
      .set("Cookie", b.cookie);
    expect(res.status).toBe(200);
    expect(res.body.referrals).toEqual([]);
  });
});

describe("referral: extending an expired trial", () => {
  it("measures the new month from now, not from the old end date", async () => {
    const referrer = await newShop("ref-i");
    const code = await ensureReferralCode(referrer.shopId);
    const friend = await newShop("friend-i", code!);

    // The referrer's trial ran out weeks ago. Adding a month to the OLD end
    // date would leave it still in the past - granting nothing at all.
    await prisma.shop.update({
      where: { id: referrer.shopId },
      data: { trialEndsAt: new Date(Date.now() - 20 * DAY) },
    });

    const customerId = `cus_${randomToken(6)}`;
    await prisma.shop.update({
      where: { id: friend.shopId },
      data: { stripeCustomerId: customerId },
    });
    await applyStripeEvent(invoicePaid(customerId));

    const days = await trialDaysLeft(referrer.shopId);
    expect(days).toBe(REFERRAL.rewardDays);
    const shop = await prisma.shop.findUnique({
      where: { id: referrer.shopId },
      select: { trialEndsAt: true },
    });
    expect(shop!.trialEndsAt!.getTime()).toBeGreaterThan(Date.now());
    expect(shop!.trialEndsAt!.getTime()).toBeLessThanOrEqual(Date.now() + REWARD_MS + 1000);
  });
});
