import request from "supertest";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { PARTNER_PROGRAM, __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * The partner program end to end: an admin creates a partner, a business
 * signs up with the code, Stripe says it paid, the partner asks to be paid and
 * an admin marks it paid.
 *
 * Price ids are set BEFORE the app is imported so the invoice lines below map
 * to real plans; STRIPE_SECRET_KEY is left unset, so nothing here can reach
 * Stripe.
 */
const STARTER = "price_partner_starter";
const PRO = "price_partner_pro";
const ADDON = "price_partner_receptionist";

let app: import("express").Express;
let applyStripeEvent: typeof import("../billing/stripe.js").applyStripeEvent;

const tag = randomToken(5).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "supersecret123";
const emails: string[] = [];
const partnerIds: string[] = [];

let adminCookie: string;
let barberCookie: string;
let partnerCookie: string;
let partnerUserId: string;
let partnerId: string;
const CODE = `ERIC ${tag}`;

async function signup(label: string): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `partner-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id, email };
}

function createShop(cookie: string, partnerCode?: string) {
  return request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: `Partner Test ${randomToken(4)}`,
      bookingUrl: "https://partner.test",
      smsAttested: true,
      ...(partnerCode !== undefined ? { partnerCode } : {}),
    });
}

/** A business that signed up with `code`, with a Stripe customer to pay from. */
async function referredShop(code = CODE): Promise<{ shopId: string; customer: string }> {
  const owner = await signup("owner");
  const res = await createShop(owner.cookie, code);
  expect(res.status).toBe(201);
  const customer = `cus_partner_${randomToken(8)}`;
  await prisma.shop.update({ where: { id: res.body.id }, data: { stripeCustomerId: customer } });
  return { shopId: res.body.id, customer };
}

let eventSeq = 0;
function invoicePaid(opts: {
  customer: string;
  invoiceId?: string;
  priceId: string;
  amountPaid: number;
  tax?: number;
  /** Newer Stripe API versions put the price at pricing.price_details.price. */
  modernLines?: boolean;
}): Stripe.Event {
  eventSeq += 1;
  return {
    id: `evt_partner_${tag}_${eventSeq}`,
    type: "invoice.paid",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.invoiceId ?? `in_partner_${randomToken(8)}`,
        object: "invoice",
        customer: opts.customer,
        amount_paid: opts.amountPaid,
        tax: opts.tax ?? 0,
        status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
        lines: {
          data: [
            opts.modernLines
              ? { pricing: { price_details: { price: opts.priceId } }, amount: opts.amountPaid }
              : { price: { id: opts.priceId }, amount: opts.amountPaid },
          ],
        },
      },
    },
  } as unknown as Stripe.Event;
}

/** `n` referrals already credited, written directly (the Stripe path is tested above). */
async function creditedRows(n: number, prefix: string): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await prisma.partnerReferral.create({
      data: {
        partnerId,
        referredShopId: `${prefix}-${tag}-${i}`,
        codeUsed: CODE,
        creditedAt: new Date(),
        creditCents: PARTNER_PROGRAM.rewardCents,
        creditPlan: "starter",
        creditInvoiceId: `in_${prefix}_${tag}_${i}`,
      },
    });
  }
}

const referralOf = (shopId: string) =>
  prisma.partnerReferral.findUniqueOrThrow({ where: { referredShopId: shopId } });

beforeAll(async () => {
  process.env.STRIPE_STARTER_PRICE_ID = STARTER;
  process.env.STRIPE_PRICE_ID = PRO;
  process.env.STRIPE_RECEPTIONIST_PRICE_ID = ADDON;
  __resetEnvCacheForTests();
  ({ applyStripeEvent } = await import("../billing/stripe.js"));
  const { createApp } = await import("../app.js");
  app = createApp();

  const admin = await signup("admin");
  adminCookie = admin.cookie;
  await prisma.user.update({ where: { id: admin.userId }, data: { isAdmin: true } });
  const barber = await signup("barber");
  barberCookie = barber.cookie;
  const partnerUser = await signup("coach");
  partnerCookie = partnerUser.cookie;
  partnerUserId = partnerUser.userId;

  const created = await request(app)
    .post("/api/admin-portal/partners")
    .set("Cookie", adminCookie)
    .send({ name: "Eric C", code: CODE, email: partnerUser.email });
  expect(created.status).toBe(201);
  partnerId = created.body.id;
  partnerIds.push(partnerId);
});

afterAll(async () => {
  await prisma.partnerCashout.deleteMany({ where: { partnerId: { in: partnerIds } } });
  await prisma.partnerReferral.deleteMany({ where: { partnerId: { in: partnerIds } } });
  await prisma.partner.deleteMany({ where: { id: { in: partnerIds } } });
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.shop.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("admin gate", () => {
  it("hides every partner route from a normal barber (the portal's 404) and a logged-out caller", async () => {
    const calls = [
      () => request(app).get("/api/admin-portal/partners"),
      () => request(app).post("/api/admin-portal/partners").send({ name: "X", code: "SNEAKY" }),
      () => request(app).post(`/api/admin-portal/partners/${partnerId}/active`).send({ active: false }),
      () => request(app).post("/api/admin-portal/partners/cashouts/anything/paid"),
    ];
    for (const call of calls) {
      expect((await call().set("Cookie", barberCookie)).status).toBe(404);
      expect((await call()).status).toBe(401);
    }
    expect(await prisma.partner.count({ where: { codeKey: "SNEAKY" } })).toBe(0);
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: partnerId } })).deactivatedAt).toBeNull();
  });
});

describe("codes", () => {
  it("refuses a second partner whose code differs only in case and spaces", async () => {
    const res = await request(app)
      .post("/api/admin-portal/partners")
      .set("Cookie", adminCookie)
      .send({ name: "Copycat", code: CODE.toLowerCase().replace(" ", "   ") });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("code_taken");
  });

  it("a signup matches the code ignoring case and spaces", async () => {
    const { shopId } = await referredShop(`  ${CODE.toLowerCase()} `);
    const row = await referralOf(shopId);
    expect(row.partnerId).toBe(partnerId);
    expect(row.creditedAt).toBeNull();
  });

  it("an unknown code is a clear 400 and creates no business", async () => {
    const owner = await signup("typo");
    const res = await createShop(owner.cookie, "NOT A REAL CODE");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_referral_code");
    expect(await prisma.shop.count({ where: { ownerId: owner.userId } })).toBe(0);
    // ...and the same person can go on without it.
    const retry = await createShop(owner.cookie, "");
    expect(retry.status).toBe(201);
    expect(await prisma.partnerReferral.count({ where: { referredShopId: retry.body.id } })).toBe(0);
  });

  it("a partner can't refer their own business", async () => {
    const res = await createShop(partnerCookie, CODE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("own_referral_code");
    expect(await prisma.shop.count({ where: { ownerId: partnerUserId } })).toBe(0);
  });

  it("a partner code wins over a legacy share link: one program per business", async () => {
    const referrer = await signup("legacyref");
    const refShop = await createShop(referrer.cookie);
    const legacyCode = `LEG${randomToken(6)}`;
    await prisma.shop.update({ where: { id: refShop.body.id }, data: { referralCode: legacyCode } });
    const owner = await signup("both");
    await prisma.user.update({ where: { id: owner.userId }, data: { referralCode: legacyCode } });
    const res = await createShop(owner.cookie, CODE);
    expect(res.status).toBe(201);
    expect(await prisma.referral.count({ where: { referredShopId: res.body.id } })).toBe(0);
    expect(await prisma.partnerReferral.count({ where: { referredShopId: res.body.id } })).toBe(1);
  });
});

describe("crediting from Stripe", () => {
  it("a paid month of a qualifying plan credits $5, once, whatever Stripe replays", async () => {
    const { shopId, customer } = await referredShop();
    const event = invoicePaid({ customer, priceId: STARTER, amountPaid: 2000 });
    await applyStripeEvent(event);
    const first = await referralOf(shopId);
    expect(first.creditCents).toBe(PARTNER_PROGRAM.rewardCents);
    expect(first.creditPlan).toBe("starter");
    expect(first.creditedAt).not.toBeNull();

    // The same event again (a webhook retry), then next month's renewal, then
    // a cancel-and-resubscribe on a pricier plan: none of them pays again.
    await applyStripeEvent(event);
    await applyStripeEvent(invoicePaid({ customer, priceId: STARTER, amountPaid: 2000 }));
    await prisma.shop.update({
      where: { id: shopId },
      data: { subscriptionStatus: "canceled", stripeSubscriptionId: null, plan: "free" },
    });
    await applyStripeEvent(invoicePaid({ customer, priceId: PRO, amountPaid: 3499 }));
    const after = await referralOf(shopId);
    expect(after.creditedAt).toEqual(first.creditedAt);
    expect(after.creditInvoiceId).toBe(first.creditInvoiceId);
    expect(after.creditPlan).toBe("starter");
  });

  it("an add-on invoice, a $0 trial invoice and a coupon month below the margin don't credit", async () => {
    const { shopId, customer } = await referredShop();
    await applyStripeEvent(invoicePaid({ customer, priceId: ADDON, amountPaid: 4000 }));
    await applyStripeEvent(invoicePaid({ customer, priceId: STARTER, amountPaid: 0 }));
    await applyStripeEvent(invoicePaid({ customer, priceId: STARTER, amountPaid: 500 }));
    // $7.50 of plan plus $1.50 tax: the tax is not ChairBack's, so still short.
    await applyStripeEvent(invoicePaid({ customer, priceId: STARTER, amountPaid: 900, tax: 150 }));
    expect((await referralOf(shopId)).creditedAt).toBeNull();
    // The first full-price month still does.
    await applyStripeEvent(invoicePaid({ customer, priceId: STARTER, amountPaid: 2000 }));
    expect((await referralOf(shopId)).creditCents).toBe(500);
  });

  it("reads the plan from the newer Stripe invoice-line shape too", async () => {
    const { shopId, customer } = await referredShop();
    await applyStripeEvent(invoicePaid({ customer, priceId: PRO, amountPaid: 3499, modernLines: true }));
    expect((await referralOf(shopId)).creditPlan).toBe("pro");
  });

  it("a business nobody referred earns nobody anything", async () => {
    const owner = await signup("organic");
    const res = await createShop(owner.cookie);
    const customer = `cus_partner_${randomToken(8)}`;
    await prisma.shop.update({ where: { id: res.body.id }, data: { stripeCustomerId: customer } });
    await applyStripeEvent(invoicePaid({ customer, priceId: PRO, amountPaid: 3499 }));
    expect(await prisma.partnerReferral.count({ where: { referredShopId: res.body.id } })).toBe(0);
  });

  it("a refund against the invoice that earned it takes the reward back, for good", async () => {
    const { shopId, customer } = await referredShop();
    const invoiceId = `in_partner_${randomToken(8)}`;
    await applyStripeEvent(invoicePaid({ customer, invoiceId, priceId: PRO, amountPaid: 3499 }));
    await applyStripeEvent({
      id: `evt_partner_refund_${tag}`,
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "ch_x", object: "charge", invoice: invoiceId } },
    } as unknown as Stripe.Event);
    const row = await referralOf(shopId);
    expect(row.reversedAt).not.toBeNull();
    expect(row.reversalReason).toBe("invoice_refunded");
    // A later paid month never re-credits it.
    await applyStripeEvent(invoicePaid({ customer, priceId: PRO, amountPaid: 3499 }));
    const again = await referralOf(shopId);
    expect(again.creditInvoiceId).toBe(invoiceId);
    expect(again.reversedAt).toEqual(row.reversedAt);
  });

  it("the database refuses a second attribution for the same business", async () => {
    const { shopId } = await referredShop();
    await expect(
      prisma.partnerReferral.create({ data: { partnerId, referredShopId: shopId, codeUsed: CODE } }),
    ).rejects.toThrow();
  });
});

describe("the partner's page and cashouts", () => {
  it("is 404 for someone who isn't a partner", async () => {
    expect((await request(app).get("/api/partner/me").set("Cookie", barberCookie)).status).toBe(404);
    const ask = await request(app)
      .post("/api/partner/me/cashouts")
      .set("Cookie", barberCookie)
      .send({ amountCents: 2500 });
    expect(ask.status).toBe(404);
  });

  it("shows earnings locked until 5 qualify, and refuses a locked cashout", async () => {
    const me = await request(app).get("/api/partner/me").set("Cookie", partnerCookie);
    expect(me.status).toBe(200);
    expect(me.body.code).toBe(CODE);
    // Three credited above; the refunded one doesn't count.
    expect(me.body.standing.qualified).toBe(3);
    expect(me.body.standing.unlock.unlocked).toBe(false);
    expect(me.body.standing.unlock.window.count).toBe(3);
    expect(me.body.standing.lockedCents).toBe(1500);
    expect(me.body.standing.availableCents).toBe(0);
    const ask = await request(app)
      .post("/api/partner/me/cashouts")
      .set("Cookie", partnerCookie)
      .send({ amountCents: 2500 });
    expect(ask.status).toBe(409);
    expect(ask.body.error).toBe("locked");
  });

  it("unlocks at 5 and releases everything earned, lapsed or not", async () => {
    // Two more qualifying referrals, paid for, inside the same window.
    for (let i = 0; i < 2; i += 1) {
      const { customer } = await referredShop();
      await applyStripeEvent(invoicePaid({ customer, priceId: STARTER, amountPaid: 2000 }));
    }
    const me = await request(app).get("/api/partner/me").set("Cookie", partnerCookie);
    expect(me.body.standing.unlock.unlocked).toBe(true);
    expect(me.body.standing.availableCents).toBe(2500);
    expect(me.body.standing.lockedCents).toBe(0);
  });

  it("allows only $25 or $50, and never more than the balance", async () => {
    const ask = (amountCents: unknown) =>
      request(app).post("/api/partner/me/cashouts").set("Cookie", partnerCookie).send({ amountCents });
    const odd = await ask(3000);
    expect(odd.status).toBe(400);
    expect(odd.body.error).toBe("invalid_amount");
    expect((await ask("2500")).status).toBe(400);
    const tooMuch = await ask(5000);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toBe("insufficient_balance");
    expect(await prisma.partnerCashout.count({ where: { partnerId } })).toBe(0);
  });

  it("two $50 requests against a $50 balance at once: exactly one wins", async () => {
    const { requestPartnerCashout } = await import("../services/partnerProgram.js");
    // 5 credited earlier + 5 more = exactly $50 available.
    await creditedRows(5, "race");
    const before = await request(app).get("/api/partner/me").set("Cookie", partnerCookie);
    expect(before.body.standing.availableCents).toBe(5000);

    const { results, settledEarly } = await raceBehindRowLock("Partner", partnerId, [
      () => requestPartnerCashout(partnerUserId, 5000),
      () => requestPartnerCashout(partnerUserId, 5000),
    ]);
    expect(settledEarly).toBe(0);
    const outcomes = winners(results);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, error: "insufficient_balance" }]);
    expect(await prisma.partnerCashout.count({ where: { partnerId } })).toBe(1);

    const after = await request(app).get("/api/partner/me").set("Cookie", partnerCookie);
    expect(after.body.standing.availableCents).toBe(0);
    expect(after.body.standing.requestedCents).toBe(5000);
  });

  it("an admin sees the pending cashout and marks it paid, once", async () => {
    const list = await request(app).get("/api/admin-portal/partners").set("Cookie", adminCookie);
    expect(list.status).toBe(200);
    const mine = list.body.partners.find((p: { id: string }) => p.id === partnerId);
    expect(mine.code).toBe(CODE);
    expect(mine.standing.unlock.unlocked).toBe(true);
    const pending = list.body.pendingCashouts.filter((c: { partnerId: string }) => c.partnerId === partnerId);
    expect(pending).toHaveLength(1);
    expect(pending[0].partnerName).toBe("Eric C");

    const paid = await request(app)
      .post(`/api/admin-portal/partners/cashouts/${pending[0].id}/paid`)
      .set("Cookie", adminCookie);
    expect(paid.status).toBe(200);
    const row = await prisma.partnerCashout.findUniqueOrThrow({ where: { id: pending[0].id } });
    expect(row.status).toBe("PAID");
    expect(row.paidAt).not.toBeNull();
    expect(row.paidByUserId).not.toBeNull();

    const again = await request(app)
      .post(`/api/admin-portal/partners/cashouts/${pending[0].id}/paid`)
      .set("Cookie", adminCookie);
    expect(again.status).toBe(409);
    const missing = await request(app)
      .post("/api/admin-portal/partners/cashouts/nope/paid")
      .set("Cookie", adminCookie);
    expect(missing.status).toBe(404);

    const me = await request(app).get("/api/partner/me").set("Cookie", partnerCookie);
    expect(me.body.standing.paidOutCents).toBe(5000);
    expect(me.body.standing.availableCents).toBe(0);
  });

  it("a switched-off partner's code stops working and their cashouts are refused", async () => {
    const off = await request(app)
      .post(`/api/admin-portal/partners/${partnerId}/active`)
      .set("Cookie", adminCookie)
      .send({ active: false });
    expect(off.status).toBe(200);
    const owner = await signup("late");
    const res = await createShop(owner.cookie, CODE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("inactive_referral_code");
    await creditedRows(5, "late");
    const ask = await request(app)
      .post("/api/partner/me/cashouts")
      .set("Cookie", partnerCookie)
      .send({ amountCents: 2500 });
    expect(ask.status).toBe(409);
    expect(ask.body.error).toBe("inactive");
    // Switched back on, the same money can be asked for.
    await request(app)
      .post(`/api/admin-portal/partners/${partnerId}/active`)
      .set("Cookie", adminCookie)
      .send({ active: true });
    const retry = await request(app)
      .post("/api/partner/me/cashouts")
      .set("Cookie", partnerCookie)
      .send({ amountCents: 2500 });
    expect(retry.status).toBe(201);
  });
});
