import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { holdTableLock, raceBehindBarrier, winners } from "../testing/raceBarrier.js";

/**
 * A TIP AFTER THE VISIT, end to end, against a FAKE Stripe.
 *
 * The client opens their appointment page once the visit is finished, picks
 * 15/20/25% or types an amount, and pays with a card they enter, Apple Pay or
 * Link. The money goes to the shop's Stripe account; Stripe's fee comes out of
 * the tip (Eric, 2026-10-05: ChairBack takes back exactly Stripe's fee as the
 * application fee and keeps none of it).
 *
 * The fake models what the code depends on: an intent created once per
 * idempotency key (the same key with different parameters is refused, as
 * Stripe does), cancelling, paying, and the charge + transfer a refund reads.
 */

type FakeIntent = {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number;
  amount_received: number;
  client_secret: string;
  latest_charge: string | null;
  metadata: Record<string, string>;
};
type FakeCharge = {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  transfer: { id: string; object: "transfer"; amount: number; amount_reversed: number } | null;
};

const fake = vi.hoisted(() => {
  const intents = new Map<string, FakeIntent>();
  const byKey = new Map<string, { id: string; params: string }>();
  const charges = new Map<string, FakeCharge>();
  const refundsByKey = new Map<string, Record<string, unknown>>();
  const calls = {
    creates: [] as Array<{ params: Record<string, unknown>; options: { idempotencyKey?: string } }>,
    cancels: [] as Array<{ id: string; options: { idempotencyKey?: string } }>,
    refunds: [] as Array<{ params: Record<string, unknown>; options: { idempotencyKey?: string } }>,
  };
  let n = 0;
  let next: "ok" | "refuse" | "timeout" | "refuse_exclusions" = "ok";
  let chargesEnabled = true;
  const err = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
  return {
    intents,
    charges,
    calls,
    setNext(m: typeof next) {
      next = m;
    },
    setChargesEnabled(v: boolean) {
      chargesEnabled = v;
    },
    reset() {
      calls.creates.length = 0;
      calls.cancels.length = 0;
      calls.refunds.length = 0;
      next = "ok";
      chargesEnabled = true;
    },
    /** The client confirms and pays: the intent succeeds and its charge exists. */
    pay(id: string, status: "succeeded" | "processing" | "requires_action" = "succeeded") {
      const pi = intents.get(id)!;
      pi.status = status;
      if (status === "succeeded") {
        pi.amount_received = pi.amount;
        pi.latest_charge = `ch_${id}`;
        charges.set(`ch_${id}`, {
          id: `ch_${id}`,
          object: "charge",
          amount: pi.amount,
          amount_refunded: 0,
          refunded: false,
          // A destination charge transfers the WHOLE amount; the application
          // fee comes back to the platform separately.
          transfer: { id: `tr_${id}`, object: "transfer", amount: pi.amount, amount_reversed: 0 },
        });
      }
    },
    client: {
      accounts: {
        retrieve: vi.fn(async () => ({
          charges_enabled: chargesEnabled,
          payouts_enabled: chargesEnabled,
          details_submitted: true,
        })),
      },
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
          calls.creates.push({ params, options });
          const key = options.idempotencyKey ?? "";
          const seen = byKey.get(key);
          if (seen) {
            if (seen.params !== JSON.stringify(params)) {
              throw err("Keys for idempotent requests can only be used with the same parameters", {
                type: "StripeIdempotencyError",
              });
            }
            return { ...intents.get(seen.id)! };
          }
          const mode = next;
          next = "ok";
          if (mode === "refuse") {
            throw err("Your account cannot currently make charges", {
              type: "StripeInvalidRequestError",
              code: "account_invalid",
            });
          }
          if (mode === "refuse_exclusions" && params.excluded_payment_method_types) {
            throw err("Invalid excluded_payment_method_types", {
              type: "StripeInvalidRequestError",
              param: "excluded_payment_method_types[0]",
            });
          }
          const id = `pi_tip_${++n}_${Math.random().toString(36).slice(2, 8)}`;
          const intent: FakeIntent = {
            id,
            object: "payment_intent",
            status: "requires_payment_method",
            amount: params.amount as number,
            amount_received: 0,
            client_secret: `${id}_secret_${n}`,
            latest_charge: null,
            metadata: (params.metadata ?? {}) as Record<string, string>,
          };
          intents.set(id, intent);
          byKey.set(key, { id, params: JSON.stringify(params) });
          if (mode === "timeout") throw new Error("socket hang up");
          return { ...intent };
        }),
        retrieve: vi.fn(async (id: string) => {
          const pi = intents.get(id);
          if (!pi) throw err("No such payment_intent", { type: "StripeInvalidRequestError" });
          return { ...pi };
        }),
        cancel: vi.fn(async (id: string, _params: unknown, options: { idempotencyKey?: string } = {}) => {
          calls.cancels.push({ id, options });
          const pi = intents.get(id);
          if (!pi) throw err("No such payment_intent", { type: "StripeInvalidRequestError" });
          if (pi.status === "succeeded" || pi.status === "processing") {
            throw err("This PaymentIntent cannot be canceled", {
              type: "StripeInvalidRequestError",
              code: "payment_intent_unexpected_state",
            });
          }
          pi.status = "canceled";
          return { ...pi };
        }),
      },
      charges: {
        retrieve: vi.fn(async (id: string) => {
          const c = charges.get(id);
          if (!c) throw err("No such charge", { type: "StripeInvalidRequestError" });
          return JSON.parse(JSON.stringify(c));
        }),
      },
      transfers: {
        retrieve: vi.fn(async (id: string) => {
          for (const c of charges.values()) if (c.transfer?.id === id) return { ...c.transfer };
          throw new Error("no such transfer");
        }),
      },
      refunds: {
        list: vi.fn(async (params: { charge: string }) => ({
          data: [...refundsByKey.values()].filter((r) => r.charge === params.charge),
        })),
        create: vi.fn(async (params: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
          calls.refunds.push({ params, options });
          if (options.idempotencyKey && refundsByKey.has(options.idempotencyKey)) {
            return refundsByKey.get(options.idempotencyKey);
          }
          const c = charges.get(params.charge as string)!;
          const amount = params.amount as number;
          if (params.reverse_transfer === true && c.transfer) c.transfer.amount_reversed += amount;
          c.amount_refunded += amount;
          c.refunded = c.amount_refunded >= c.amount;
          const refund = {
            id: `re_tip_${++n}_${Math.random().toString(36).slice(2, 8)}`,
            object: "refund",
            amount,
            status: "succeeded",
            charge: c.id,
            metadata: (params.metadata ?? {}) as Record<string, string>,
            transfer_reversal: params.reverse_transfer === true ? `trr_${n}` : null,
          };
          if (options.idempotencyKey) refundsByKey.set(options.idempotencyKey, refund);
          return refund;
        }),
      },
    },
  };
});

vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  stripeClient: () => fake.client,
}));

let app: Express;
let cookie: string;
let shopId: string;
let otherCookie: string;
let staffId: string;
let serviceId: string;
let clientId: string;
const email = `tips-${randomToken(6)}@test.local`.toLowerCase();
const otherEmail = `tips2-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;

async function makeShop(ownerEmail: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Tipped", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: "Tip Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie: c, shopId: shop.body.id as string };
}

let seq = 0;
/** A visit that is over: COMPLETED an hour ago, with a client, at $40. */
async function visit(over: Partial<{
  status: "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
  endsAgoMin: number;
  priceDollars: number | null;
  clientId: string | null;
  groupId: string | null;
}> = {}) {
  seq += 1;
  const endsAt = new Date(Date.now() - (over.endsAgoMin ?? 60) * 60_000 - seq * 1000);
  const startsAt = new Date(endsAt.getTime() - 30 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Pat",
      lastName: "Client",
      startsAt,
      endsAt,
      status: over.status ?? "COMPLETED",
      ...(over.status === "CANCELED" ? { canceledAt: new Date() } : {}),
      clientId: over.clientId === undefined ? clientId : over.clientId,
      groupId: over.groupId ?? null,
      manageToken: randomToken(20),
      priceAtBooking:
        over.priceDollars === null ? null : new Prisma.Decimal((over.priceDollars ?? 40).toFixed(2)),
    },
  });
  return appt;
}

const managePage = (token: string) => request(app).get(`/api/book/manage/${token}`);
const startTip = (token: string, body: Record<string, unknown>) =>
  request(app).post(`/api/book/manage/${token}/tip`).send(body);
const tipStatus = (token: string) => request(app).get(`/api/book/manage/${token}/tip`);

const liveTips = (appointmentId: string) =>
  prisma.payment.findMany({
    where: { appointmentId, purpose: "tip", status: { notIn: ["failed", "canceled"] } },
  });
const allTips = (appointmentId: string) =>
  prisma.payment.findMany({ where: { appointmentId, purpose: "tip" }, orderBy: { createdAt: "asc" } });

async function setShop(data: Prisma.ShopUpdateInput) {
  await prisma.shop.update({ where: { id: shopId }, data });
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  // Resolved once, before any race: a mock is not shared until the module is.
  await import("../billing/stripe.js");
  await import("../billing/tips.js");
  await import("../billing/depositRefund.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const mine = await makeShop(email);
  cookie = mine.cookie;
  shopId = mine.shopId;
  const other = await makeShop(otherEmail);
  otherCookie = other.cookie;
  await prisma.shop.update({
    where: { id: other.shopId },
    data: { stripeConnectAccountId: `acct_test_${randomToken(6)}`, connectChargesEnabled: true, compAccess: true },
  });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `anon:${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Pat",
      lastName: "Client",
    },
  });
  clientId = client.id;
});

beforeEach(async () => {
  fake.reset();
  await setShop({
    stripeConnectAccountId: ACCT,
    connectChargesEnabled: true,
    compAccess: true,
    onlineTipsEnabled: true,
    tipPolicy: "not_included",
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  const other = await prisma.user.findUnique({ where: { email: otherEmail }, select: { id: true } });
  if (other) await prisma.shop.deleteMany({ where: { ownerId: other.id } });
});

describe("who is offered a tip", () => {
  it("🔴 a finished visit's page offers 15/20/25% of its price, $1 to $200, for 7 days", async () => {
    const appt = await visit();
    const res = await managePage(appt.manageToken);
    expect(res.status).toBe(200);
    expect(res.body.tip).toEqual({
      state: "open",
      presets: [
        { percent: 15, cents: 600 },
        { percent: 20, cents: 800 },
        { percent: 25, cents: 1000 },
      ],
      minCents: 100,
      maxCents: 20000,
      closesAt: new Date(appt.endsAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    });
    // The Stripe account never rides along to the page.
    expect(JSON.stringify(res.body)).not.toContain(ACCT);
  });

  it("an unpriced visit gets a custom amount only", async () => {
    const appt = await visit({ priceDollars: null });
    const res = await managePage(appt.manageToken);
    expect(res.body.tip.state).toBe("open");
    expect(res.body.tip.presets).toEqual([]);
  });

  it("no tip card unless every rule holds", async () => {
    const cases: Array<[string, () => Promise<{ manageToken: string }>]> = [
      ["shop switched tips off", async () => {
        await setShop({ onlineTipsEnabled: false });
        return visit();
      }],
      ["shop says the price includes a tip", async () => {
        await setShop({ tipPolicy: "included" });
        return visit();
      }],
      ["Stripe not ready", async () => {
        await setShop({ connectChargesEnabled: false });
        return visit();
      }],
      ["no Stripe account", async () => {
        await setShop({ stripeConnectAccountId: null });
        return visit();
      }],
      ["visit not finished (BOOKED, even past its end)", () => visit({ status: "BOOKED" })],
      ["cancelled", () => visit({ status: "CANCELED" })],
      ["no-show", () => visit({ status: "NO_SHOW" })],
      ["no client (a walk-in receipt)", () => visit({ clientId: null })],
      ["a group booking", async () => {
        const group = await prisma.appointmentGroup.create({
          data: { shopId, staffId, clientId, firstName: "Pat", manageToken: randomToken(20) },
        });
        return visit({ groupId: group.id });
      }],
      ["past the 7-day window", () => visit({ endsAgoMin: 7 * 24 * 60 + 5 })],
    ];
    for (const [label, make] of cases) {
      await setShop({
        stripeConnectAccountId: ACCT,
        connectChargesEnabled: true,
        onlineTipsEnabled: true,
        tipPolicy: "not_included",
      });
      const appt = await make();
      const page = await managePage(appt.manageToken);
      expect(page.status, label).toBe(200);
      expect(page.body.tip ?? null, label).toBeNull();
      // And the server refuses to charge what the page does not offer.
      const res = await startTip(appt.manageToken, { amountCents: 800 });
      expect(res.status, label).toBe(409);
      expect(res.body.error, label).toBe("tip_closed");
    }
    expect(fake.calls.creates).toHaveLength(0);
  });

  it("an unknown link is not found", async () => {
    expect((await startTip("nope-not-a-token", { amountCents: 800 })).status).toBe(404);
    expect((await tipStatus("nope-not-a-token")).status).toBe(404);
  });
});

describe("paying a tip", () => {
  it("🔴 the charge: to the shop's account, Stripe's fee taken back, card/Apple Pay/Link only, tagged a tip", async () => {
    const appt = await visit();
    const res = await startTip(appt.manageToken, { amountCents: 800 });
    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(800);
    expect(res.body.clientSecret).toMatch(/_secret_/);

    const [row] = await liveTips(appt.id);
    expect(row).toMatchObject({
      purpose: "tip",
      mode: "ahead",
      amount: 800,
      applicationFeeAmount: 53, // 2.9% + 30c
      status: "requires_payment_method",
      stripeConnectAccountId: ACCT,
    });
    expect(row!.stripePaymentIntentId).toMatch(/^pi_tip_/);

    expect(fake.calls.creates).toHaveLength(1);
    const { params, options } = fake.calls.creates[0]!;
    expect(params).toMatchObject({
      amount: 800,
      currency: "usd",
      on_behalf_of: ACCT,
      transfer_data: { destination: ACCT },
      application_fee_amount: 53,
      capture_method: "automatic",
      automatic_payment_methods: { enabled: true },
      description: "Haircut - tip",
      metadata: { purpose: "tip", paymentId: row!.id, appointmentId: appt.id, shopId },
    });
    expect(params.excluded_payment_method_types).toEqual(expect.arrayContaining(["cashapp", "klarna", "us_bank_account"]));
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params).not.toHaveProperty("off_session");
    expect(options.idempotencyKey).toBe(`tip-pi:${row!.id}`);
  });

  it("only amounts the page could offer: whole cents, $1 to $200", async () => {
    const appt = await visit();
    for (const [body, error] of [
      [{ amountCents: 99 }, "invalid_amount"],
      [{ amountCents: 20001 }, "invalid_amount"],
      [{ amountCents: 12.5 }, "invalid_input"],
      [{ amountCents: "800" }, "invalid_input"],
      [{}, "invalid_input"],
      [{ amountCents: 800, currency: "eur" }, "invalid_input"],
    ] as const) {
      const res = await startTip(appt.manageToken, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error, JSON.stringify(body)).toBe(error);
    }
    expect(fake.calls.creates).toHaveLength(0);
    expect(await allTips(appt.id)).toHaveLength(0);
    // A custom amount inside the range is fine.
    expect((await startTip(appt.manageToken, { amountCents: 1234 })).status).toBe(200);
  });

  it("asking again for the same amount hands back the same payment - no second intent", async () => {
    const appt = await visit();
    const first = await startTip(appt.manageToken, { amountCents: 800 });
    const again = await startTip(appt.manageToken, { amountCents: 800 });
    expect(again.status).toBe(200);
    expect(again.body.clientSecret).toBe(first.body.clientSecret);
    expect(fake.calls.creates).toHaveLength(1);
    expect(await liveTips(appt.id)).toHaveLength(1);
  });

  it("🔴 changing the amount before paying retires the first attempt, at Stripe and here", async () => {
    const appt = await visit();
    const first = await startTip(appt.manageToken, { amountCents: 600 });
    const [firstRow] = await liveTips(appt.id);
    const second = await startTip(appt.manageToken, { amountCents: 1000 });
    expect(second.status).toBe(200);
    expect(second.body.clientSecret).not.toBe(first.body.clientSecret);

    expect(fake.calls.cancels).toEqual([
      { id: firstRow!.stripePaymentIntentId, options: { idempotencyKey: `tip-cancel:${firstRow!.id}` } },
    ]);
    expect(fake.intents.get(firstRow!.stripePaymentIntentId)!.status).toBe("canceled");
    const rows = await allTips(appt.id);
    expect(rows.map((r) => [r.amount, r.status])).toEqual([
      [600, "canceled"],
      [1000, "requires_payment_method"],
    ]);
  });

  it("a different amount while the first is mid-3-D Secure is refused - it is left to finish", async () => {
    const appt = await visit();
    await startTip(appt.manageToken, { amountCents: 600 });
    const [row] = await liveTips(appt.id);
    fake.pay(row!.stripePaymentIntentId, "requires_action");
    await prisma.payment.update({ where: { id: row!.id }, data: { status: "requires_action" } });
    const res = await startTip(appt.manageToken, { amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("tip_in_progress");
    expect(fake.calls.cancels).toHaveLength(0);
  });

  it("🔴 one tip per visit: once paid, the page thanks them and no second tip can start", async () => {
    const appt = await visit();
    await startTip(appt.manageToken, { amountCents: 800 });
    const [row] = await liveTips(appt.id);
    fake.pay(row!.stripePaymentIntentId);

    // The page polls; the server asks Stripe rather than wait for the webhook.
    const status = await tipStatus(appt.manageToken);
    expect(status.status).toBe(200);
    expect(status.body.tip).toEqual({ state: "paid", amountCents: 800 });
    expect((await managePage(appt.manageToken)).body.tip).toEqual({ state: "paid", amountCents: 800 });

    const again = await startTip(appt.manageToken, { amountCents: 500 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_tipped");

    // A paid tip is still shown after the shop switches tips off.
    await setShop({ onlineTipsEnabled: false });
    expect((await managePage(appt.manageToken)).body.tip).toEqual({ state: "paid", amountCents: 800 });
  });

  it("if Stripe refuses the method exclusions, every method is offered under its own key", async () => {
    const appt = await visit();
    fake.setNext("refuse_exclusions");
    const res = await startTip(appt.manageToken, { amountCents: 800 });
    expect(res.status).toBe(200);
    const [row] = await liveTips(appt.id);
    expect(fake.calls.creates.map((c) => c.options.idempotencyKey)).toEqual([
      `tip-pi:${row!.id}`,
      `tip-pi:${row!.id}:all-methods`,
    ]);
    expect(fake.calls.creates[1]!.params).not.toHaveProperty("excluded_payment_method_types");
  });

  it("Stripe refuses to create it: the attempt is dead, and the visit is free for a fresh one", async () => {
    const appt = await visit();
    fake.setNext("refuse");
    const res = await startTip(appt.manageToken, { amountCents: 800 });
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "tip_refused", code: "account_invalid" });
    expect((await allTips(appt.id)).map((r) => r.status)).toEqual(["failed"]);

    const retry = await startTip(appt.manageToken, { amountCents: 800 });
    expect(retry.status).toBe(200);
    expect(await liveTips(appt.id)).toHaveLength(1);
  });

  it("🔴 a lost answer: 'try again' is safe - the retry names the same request and gets the same payment", async () => {
    const appt = await visit();
    fake.setNext("timeout");
    const first = await startTip(appt.manageToken, { amountCents: 800 });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ ok: false, result: "unconfirmed" });
    const [pending] = await liveTips(appt.id);
    expect(pending!.stripePaymentIntentId).toMatch(/^pending:/);
    expect(pending!.ambiguousAt).not.toBeNull();

    const retry = await startTip(appt.manageToken, { amountCents: 800 });
    expect(retry.status).toBe(200);
    // One intent at Stripe, adopted by the one row.
    expect(fake.intents.size).toBeGreaterThan(0);
    const keys = fake.calls.creates.map((c) => c.options.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`tip-pi:${pending!.id}`]));
    const [row] = await liveTips(appt.id);
    expect(row!.id).toBe(pending!.id);
    expect(row!.stripePaymentIntentId).toMatch(/^pi_tip_/);
    expect(row!.ambiguousAt).toBeNull();
  });

  it("🔴 two tabs pressing Pay at once: one tip row, one payment, both handed the same one", async () => {
    const appt = await visit();
    const barrier = await holdTableLock("Payment");
    const { results, settledEarly } = await raceBehindBarrier(barrier, [
      () => startTip(appt.manageToken, { amountCents: 800 }),
      () => startTip(appt.manageToken, { amountCents: 800 }),
    ]);
    expect(settledEarly).toBe(0);
    const answers = winners(results);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(answers[0]!.body.clientSecret).toBe(answers[1]!.body.clientSecret);
    expect(await allTips(appt.id)).toHaveLength(1);
    const created = new Set(
      fake.calls.creates.map((c) => (c.params.metadata as Record<string, string>).paymentId),
    );
    expect(created.size).toBe(1);
  });
});

describe("the shop's side of a tip", () => {
  it("🔴 the appointment shows the tip on its own line; Refund tip gives the client everything back and leaves Stripe's fee with the shop", async () => {
    const appt = await visit();
    await startTip(appt.manageToken, { amountCents: 800 });
    const [row] = await liveTips(appt.id);
    fake.pay(row!.stripePaymentIntentId);
    await tipStatus(appt.manageToken);

    const detail = await request(app).get(`/api/booking/appointments/${appt.id}/detail`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.tip).toEqual({
      amountCents: 800,
      feeCents: 53,
      refundedCents: 0,
      refundableCents: 800,
      processing: false,
    });
    // Never money toward the service.
    expect(detail.body.payment.collectedCents).toBe(0);

    const refund = await request(app)
      .post(`/api/booking/appointments/${appt.id}/tip-refund`)
      .set("Cookie", cookie)
      .send({ amountCents: 800, note: "asked for it back" });
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ ok: true, result: "refunded", amountCents: 800 });
    const { params, options } = fake.calls.refunds[0]!;
    expect(params).toMatchObject({
      charge: `ch_${row!.stripePaymentIntentId}`,
      amount: 800,
      reverse_transfer: true,
      metadata: { source: "chairback_tip_refund", paymentId: row!.id },
    });
    // 🔴 ChairBack's fee is NOT returned: it paid Stripe's fee, which Stripe keeps.
    expect(params).not.toHaveProperty("refund_application_fee");
    expect(options.idempotencyKey).toBe(`tip-refund:${row!.id}:0`);
    const ledger = await prisma.paymentRefund.findMany({ where: { paymentId: row!.id } });
    expect(ledger.map((l) => [l.outcome, l.amountCents, l.note])).toEqual([["succeeded", 800, "asked for it back"]]);

    const after = await request(app).get(`/api/booking/appointments/${appt.id}/detail`).set("Cookie", cookie);
    expect(after.body.tip).toMatchObject({ refundedCents: 800, refundableCents: 0 });
    expect((await managePage(appt.manageToken)).body.tip).toEqual({ state: "refunded", amountCents: 800 });
    // Still one tip per visit, even after a refund.
    expect((await startTip(appt.manageToken, { amountCents: 500 })).status).toBe(409);
  });

  it("only the shop's own tips, and only managers", async () => {
    const appt = await visit();
    await startTip(appt.manageToken, { amountCents: 800 });
    const [row] = await liveTips(appt.id);
    fake.pay(row!.stripePaymentIntentId);
    await tipStatus(appt.manageToken);
    const res = await request(app)
      .post(`/api/booking/appointments/${appt.id}/tip-refund`)
      .set("Cookie", otherCookie)
      .send({ amountCents: 800 });
    expect(res.status).toBe(404);
    expect(fake.calls.refunds).toHaveLength(0);
    // A visit with no tip: nothing to refund.
    const plain = await visit();
    const none = await request(app)
      .post(`/api/booking/appointments/${plain.id}/tip-refund`)
      .set("Cookie", cookie)
      .send({ amountCents: 800 });
    expect(none.status).toBe(404);
  });

  it("🔴 a tipped visit cannot be cancelled until the tip is refunded", async () => {
    const appt = await visit();
    await startTip(appt.manageToken, { amountCents: 800 });
    const [row] = await liveTips(appt.id);
    fake.pay(row!.stripePaymentIntentId);
    await tipStatus(appt.manageToken);

    const cancel = await request(app).post(`/api/booking/appointments/${appt.id}/cancel`).set("Cookie", cookie);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("tip_paid");
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("COMPLETED");

    await request(app)
      .post(`/api/booking/appointments/${appt.id}/tip-refund`)
      .set("Cookie", cookie)
      .send({ amountCents: 800 });
    const again = await request(app).post(`/api/booking/appointments/${appt.id}/cancel`).set("Cookie", cookie);
    expect(again.status).toBe(200);
  });

  it("attempts nobody finished are let go after a day; a paid tip and a fresh attempt are untouched", async () => {
    const { sweepAbandonedTipIntents } = await import("../billing/tips.js");
    const stale = await visit();
    await startTip(stale.manageToken, { amountCents: 800 });
    const [staleRow] = await liveTips(stale.id);
    await prisma.payment.update({
      where: { id: staleRow!.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    const fresh = await visit();
    await startTip(fresh.manageToken, { amountCents: 800 });
    const paid = await visit();
    await startTip(paid.manageToken, { amountCents: 800 });
    const [paidRow] = await liveTips(paid.id);
    fake.pay(paidRow!.stripePaymentIntentId);
    await tipStatus(paid.manageToken);
    await prisma.payment.update({
      where: { id: paidRow!.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });

    await sweepAbandonedTipIntents(new Date());
    expect(fake.calls.cancels.map((c) => c.id)).toEqual([staleRow!.stripePaymentIntentId]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: staleRow!.id } })).status).toBe("canceled");
    expect(await liveTips(fresh.id)).toHaveLength(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paidRow!.id } })).status).toBe("succeeded");
  });

  it("the Tips switch: off by default, on only with Stripe ready, off always", async () => {
    await setShop({ onlineTipsEnabled: false });
    const status = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(status.body.onlineTipsEnabled).toBe(false);

    fake.setChargesEnabled(false);
    const refused = await request(app).patch("/api/payments/tips").set("Cookie", cookie).send({ enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("connect_not_ready");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).onlineTipsEnabled).toBe(false);

    fake.setChargesEnabled(true);
    const on = await request(app).patch("/api/payments/tips").set("Cookie", cookie).send({ enabled: true });
    expect(on.status).toBe(200);
    expect((await request(app).get("/api/payments/status").set("Cookie", cookie)).body.onlineTipsEnabled).toBe(true);

    // Stripe slipped: turning tips OFF still works.
    fake.setChargesEnabled(false);
    const off = await request(app).patch("/api/payments/tips").set("Cookie", cookie).send({ enabled: false });
    expect(off.status).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).onlineTipsEnabled).toBe(false);
    expect((await request(app).patch("/api/payments/tips").set("Cookie", cookie).send({ enabled: "yes" })).status).toBe(400);
  });
});
