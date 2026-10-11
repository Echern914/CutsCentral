import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { COMPLETED_VISIT_CORRECTION_DAYS, randomToken } from "@chairback/config";

/**
 * POST /api/booking/appointments/:id/correct-completed - a shop owner: an 8:00
 * booking whose client never came "shows Completed and I can't remove him from
 * my schedule. Should have option to put him as a no show or canceled appt."
 *
 * The 15-minute sweep had already turned it into a completed visit with a
 * punch. Putting it right after the fact is a CORRECTION, so what matters is
 * what it must NOT do:
 *   - tell anybody (no email intent, text, push, Wallet poke, slot-opened alert
 *     or Auto-fill run) - the time is in the past;
 *   - move money (no refund, no card-on-file no-show fee, no Stripe call); a
 *     visit with money on it, or checked out at the chair, is refused with
 *     nothing changed;
 *   - reach another shop, a synced booking, a walk-in, or a visit older than
 *     the correction window.
 * And what it must do: the punch it earned comes back off through the ledger,
 * and it leaves the takings (the ONE revenue read, readChairEvents).
 */

const notifySlotOpened = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../engines/slotOpened.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engines/slotOpened.js")>()),
  notifySlotOpened,
}));
const pokeAppointmentPass = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../wallet/appointmentPass.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wallet/appointmentPass.js")>()),
  pokeAppointmentPass,
}));
const refundForCancellation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../billing/payments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/payments.js")>()),
  refundForCancellation,
}));
const settleCardOnFile = vi.hoisted(() => vi.fn(async () => ({ action: "none" as const })));
vi.mock("../services/cardOnFileSettle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cardOnFileSettle.js")>()),
  settleCardOnFile,
}));
const releaseCardOnFile = vi.hoisted(() => vi.fn(async () => ({ released: false })));
vi.mock("../billing/cardOnFile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/cardOnFile.js")>()),
  releaseCardOnFile,
}));
// Any Stripe call at all is a failure here.
const stripeClient = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Stripe must not be called by a correction");
  }),
);
vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  stripeClient,
}));

const { createApp } = await import("../app.js");
const { promoteOneAppointmentInTx, cancelAppointment, CancelRefusedError } = await import(
  "../engines/appointmentPromotion.js"
);
const { readChairEvents } = await import("../engines/insightsWindow.js");
const { __setMessageProviderForTests } = await import("../messaging/twilio.js");
const { __setPushSenderForTests } = await import("../messaging/push.js");

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];
const DAY = 86_400_000;

const texts: unknown[] = [];
const pushes: unknown[] = [];
beforeEach(() => {
  texts.length = 0;
  pushes.length = 0;
  __setMessageProviderForTests({
    channel: "SMS",
    async send(input) {
      texts.push(input);
      return { providerMessageId: `test-${randomToken(6)}`, status: "queued" } as never;
    },
  });
  __setPushSenderForTests({
    async send(_sub, payload) {
      pushes.push(payload);
    },
  });
  for (const m of [
    notifySlotOpened,
    pokeAppointmentPass,
    refundForCancellation,
    settleCardOnFile,
    releaseCardOnFile,
    stripeClient,
  ]) {
    m.mockClear();
  }
});
afterEach(() => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
});

interface Shop {
  cookie: string;
  shopId: string;
  staffId: string;
  serviceId: string;
}

async function makeShop(label: string): Promise<Shop> {
  const email = `ccv-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://ccv.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  shopIds.push(shopId);
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      bookingMode: "native",
      timezone: "UTC",
      rewardsEnabled: true,
      rewardsStartedAt: null,
      punchesPerVisit: 1,
      // A shop that WOULD charge a no-show fee on a kept card: the correction
      // must still never charge one.
      chargeCardOnFileFees: true,
    },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Solo" }, select: { id: true } });
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: svc.id };
}

/**
 * A booking for a client WITH an email (so a cancellation email would go),
 * which ended `endedAgoMs` ago and was then completed the way the 15-minute
 * sweep completes it (`byShop` false) - or by the shop's Done (`byShop` true).
 */
async function autoCompleted(
  s: Shop,
  opts: { endedAgoMs?: number; byShop?: boolean; data?: Record<string, unknown> } = {},
): Promise<{ id: string; clientId: string; visitId: string }> {
  const client = await prisma.client.create({
    data: {
      shopId: s.shopId,
      firstName: "Sample",
      email: `ccv-client-${randomToken(5)}@test.chairback`.toLowerCase(),
      phone: "+15555550123",
      smsConsentAt: new Date(),
      acuityClientKey: `ccv-${randomToken(8)}`,
      magicToken: randomToken(),
    },
    select: { id: true },
  });
  const endsAt = new Date(Date.now() - (opts.endedAgoMs ?? 2 * 3_600_000));
  const startsAt = new Date(endsAt.getTime() - 30 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      clientId: client.id,
      firstName: "Sample",
      email: `ccv-appt-${randomToken(5)}@test.chairback`.toLowerCase(),
      startsAt,
      endsAt,
      priceAtBooking: 40,
      status: "BOOKED",
      manageToken: randomToken(),
      ...(opts.data ?? {}),
    },
    select: { id: true },
  });
  const outcome = await runWithShop(s.shopId, (tx) =>
    promoteOneAppointmentInTx(
      tx,
      { id: s.shopId, punchesPerVisit: 1 },
      {
        id: appt.id,
        clientId: client.id,
        startsAt,
        endsAt,
        priceAtBooking: null,
        serviceName: "Cut",
      },
      new Date(),
      { byShop: opts.byShop === true },
    ),
  );
  expect(outcome.promoted && outcome.earn?.earned).toBe(1);
  const r = await row(appt.id);
  expect(r.status).toBe("COMPLETED");
  return { id: appt.id, clientId: client.id, visitId: r.visitId! };
}

const correct = (s: Shop, id: string, outcome: "no_show" | "canceled") =>
  request(app)
    .post(`/api/booking/appointments/${id}/correct-completed`)
    .set("Cookie", s.cookie)
    .send({ outcome });

const detail = (s: Shop, id: string) =>
  request(app).get(`/api/booking/appointments/${id}/detail`).set("Cookie", s.cookie);

const row = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      canceledAt: true,
      dismissedAt: true,
      cancellationRevision: true,
      visitId: true,
      completedByShop: true,
    },
  });

async function takings(shopId: string): Promise<number> {
  const now = Date.now();
  const { events } = await readChairEvents(shopId, new Date(now - 10 * DAY), new Date(now + DAY));
  return events.reduce((sum, e) => sum + e.earnedCents, 0);
}

async function balance(shopId: string, clientId: string): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

/** Nothing anywhere said anything to anybody. */
async function expectNobodyTold(shopId: string) {
  expect(await prisma.emailIntent.count({ where: { shopId } })).toBe(0);
  expect(await prisma.autoFillRun.count({ where: { shopId } })).toBe(0);
  expect(texts).toHaveLength(0);
  expect(pushes).toHaveLength(0);
  expect(notifySlotOpened).not.toHaveBeenCalled();
  expect(pokeAppointmentPass).not.toHaveBeenCalled();
}

/** And no money moved, and Stripe was never asked. */
async function expectNoMoneyMoved(shopId: string) {
  expect(refundForCancellation).not.toHaveBeenCalled();
  expect(settleCardOnFile).not.toHaveBeenCalled();
  expect(releaseCardOnFile).not.toHaveBeenCalled();
  expect(stripeClient).not.toHaveBeenCalled();
  // No fee row of any kind was written.
  expect(await prisma.payment.count({ where: { shopId, purpose: { not: "tip" } } })).toBe(0);
}

async function payment(s: Shop, appointmentId: string, purpose: string, status: string) {
  await prisma.payment.create({
    data: {
      shopId: s.shopId,
      appointmentId,
      stripePaymentIntentId: `pi_${randomToken(14)}`,
      stripeConnectAccountId: "acct_test_ccv",
      mode: "ahead",
      purpose,
      amount: 1000,
      status,
    },
  });
}

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  // EmailIntent has no FK to Shop: drained by OUR shop ids, never globally.
  if (shopIds.length) await prisma.emailIntent.deleteMany({ where: { shopId: { in: shopIds } } });
  if (emails.length) {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    await prisma.shop.deleteMany({ where: { ownerId: { in: users.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  }
  await prisma.$disconnect();
});

describe("mark a completed visit a no-show or cancelled, after the fact", () => {
  it("no-show: NO_SHOW, punch reversed through the ledger, out of the takings, nobody told, no fee", async () => {
    const s = await makeShop("CCV no-show");
    const v = await autoCompleted(s);
    // A card kept at booking was let go when the visit completed - the fee
    // path must not find anything to charge, and must not even be asked.
    await prisma.cardOnFile.create({
      data: {
        id: `cof_${randomToken(10)}`,
        shopId: s.shopId,
        appointmentId: v.id,
        stripeCustomerId: `cus_${randomToken(10)}`,
        stripeSetupIntentId: `seti_${randomToken(12)}`,
        status: "released",
        releasedAt: new Date(),
      },
    });

    const before = await detail(s, v.id);
    expect(before.status).toBe(200);
    expect(before.body.correctable).toBe(true);
    expect(await takings(s.shopId)).toBe(4000);
    expect(await balance(s.shopId, v.clientId)).toBe(1);

    const res = await correct(s, v.id, "no_show");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyCorrected: false });

    const r = await row(v.id);
    expect(r.status).toBe("NO_SHOW");
    expect(r.canceledAt).toBeNull();
    // Stays on the day as a no-show, like one marked in time.
    expect(r.dismissedAt).toBeNull();
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: v.visitId } });
    expect(visit.status).toBe("NO_SHOW");
    expect(visit.noShow).toBe(true);
    expect(visit.completedAt).toBeNull();

    // Reversed, not edited: the earn row stands and a reversal offsets it.
    expect(await balance(s.shopId, v.clientId)).toBe(0);
    const ledger = await prisma.punchLedger.findMany({
      where: { shopId: s.shopId, clientId: v.clientId },
      select: { reversalOfId: true },
    });
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((l) => l.reversalOfId !== null)).toHaveLength(1);

    expect(await takings(s.shopId)).toBe(0);
    expect((await detail(s, v.id)).body.correctable).toBe(false);
    await expectNobodyTold(s.shopId);
    await expectNoMoneyMoved(s.shopId);
  });

  it("cancelled: CANCELED, punch reversed, out of the takings, and still no cancellation email", async () => {
    const s = await makeShop("CCV cancel");
    const v = await autoCompleted(s);
    expect(await takings(s.shopId)).toBe(4000);

    const res = await correct(s, v.id, "canceled");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyCorrected: false });

    const r = await row(v.id);
    expect(r.status).toBe("CANCELED");
    expect(r.canceledAt).not.toBeNull();
    expect(r.dismissedAt).toBeNull();
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: v.visitId } })).status).toBe(
      "CANCELED",
    );
    expect(await balance(s.shopId, v.clientId)).toBe(0);
    expect(await takings(s.shopId)).toBe(0);
    await expectNobodyTold(s.shopId);
    await expectNoMoneyMoved(s.shopId);
  });

  it("a visit the shop pressed Done on is corrected the same way", async () => {
    const s = await makeShop("CCV done");
    const v = await autoCompleted(s, { byShop: true });
    expect((await row(v.id)).completedByShop).toBe(true);
    expect((await detail(s, v.id)).body.correctable).toBe(true);
    expect((await correct(s, v.id, "no_show")).status).toBe(200);
    expect((await row(v.id)).status).toBe("NO_SHOW");
    expect(await balance(s.shopId, v.clientId)).toBe(0);
  });

  it("a second correction is a no-op answer, not an error", async () => {
    const s = await makeShop("CCV twice");
    for (const outcome of ["no_show", "canceled"] as const) {
      const v = await autoCompleted(s);
      expect((await correct(s, v.id, outcome)).status).toBe(200);
      const first = await row(v.id);
      const again = await correct(s, v.id, outcome);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ok: true, alreadyCorrected: true });
      const second = await row(v.id);
      expect(second).toEqual(first);
      expect(
        await prisma.punchLedger.count({ where: { shopId: s.shopId, clientId: v.clientId } }),
      ).toBe(2);
    }
    await expectNobodyTold(s.shopId);
  });

  it("is open inside the window and refused past it, with nothing changed", async () => {
    const s = await makeShop("CCV window");
    const inside = await autoCompleted(s, {
      endedAgoMs: (COMPLETED_VISIT_CORRECTION_DAYS - 1) * DAY,
    });
    expect((await detail(s, inside.id)).body.correctable).toBe(true);

    const old = await autoCompleted(s, {
      endedAgoMs: (COMPLETED_VISIT_CORRECTION_DAYS + 1) * DAY,
    });
    expect((await detail(s, old.id)).body.correctable).toBe(false);
    const res = await correct(s, old.id, "no_show");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("too_old");
    expect(res.body.message).toMatch(/more than 7 days ago/);
    expect((await row(old.id)).status).toBe("COMPLETED");
    expect(await balance(s.shopId, old.clientId)).toBe(1);
  });

  it("refuses a visit synced from Acuity or Square", async () => {
    const s = await makeShop("CCV synced");
    for (const sourceId of [`${Date.now()}${Math.floor(Math.random() * 1000)}`, `square:${randomToken(8)}`]) {
      const v = await autoCompleted(s);
      // Re-point it at a Visit that platform ingested.
      const synced = await prisma.visit.create({
        data: {
          shopId: s.shopId,
          clientId: v.clientId,
          acuityAppointmentId: sourceId,
          status: "COMPLETED",
          scheduledAt: new Date(Date.now() - 3 * 3_600_000),
          completedAt: new Date(),
        },
        select: { id: true },
      });
      await prisma.appointment.update({ where: { id: v.id }, data: { visitId: synced.id } });
      expect((await detail(s, v.id)).body.correctable).toBe(false);
      const res = await correct(s, v.id, "no_show");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("external");
      expect((await row(v.id)).status).toBe("COMPLETED");
    }
  });

  it("refuses a walk-in: recorded (it has Remove walk-in) or from the queue", async () => {
    const s = await makeShop("CCV walk-in");
    const rec = await request(app)
      .post("/api/booking/appointments/walk-in")
      .set("Cookie", s.cookie)
      .send({ amount: 40 });
    expect(rec.status).toBe(201);
    const recorded = await correct(s, rec.body.id as string, "no_show");
    expect(recorded.status).toBe(409);
    expect(recorded.body.error).toBe("walk_in");
    expect((await row(rec.body.id as string)).status).toBe("COMPLETED");

    const queued = await autoCompleted(s, { data: { bookedVia: "walk_in_queue" } });
    expect((await detail(s, queued.id)).body.correctable).toBe(false);
    const res = await correct(s, queued.id, "canceled");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("walk_in");
    expect((await row(queued.id)).status).toBe("COMPLETED");
  });

  it("refuses a visit with money on it - a tip, a checkout, a payable form, a kept card - and changes nothing", async () => {
    const s = await makeShop("CCV money");
    const cases: Array<(id: string) => Promise<void>> = [
      (id) => payment(s, id, "service_checkout", "succeeded"),
      // A deposit that has not settled is not the collected deposit a no-show keeps.
      (id) => payment(s, id, "booking", "processing"),
      (id) => payment(s, id, "tip", "succeeded"),
      (id) => payment(s, id, "tip", "requires_payment_method"),
      async (id) => {
        // A kept card the completion never let go of: a no-show would CHARGE
        // it on the ordinary path. Here it is refused instead.
        await prisma.cardOnFile.create({
          data: {
            id: `cof_${randomToken(10)}`,
            shopId: s.shopId,
            appointmentId: id,
            stripeCustomerId: `cus_${randomToken(10)}`,
            stripeSetupIntentId: `seti_${randomToken(12)}`,
            stripePaymentMethodId: `pm_${randomToken(10)}`,
            status: "saved",
            savedAt: new Date(),
          },
        });
      },
    ];
    for (const addMoney of cases) {
      const v = await autoCompleted(s);
      await addMoney(v.id);
      expect((await detail(s, v.id)).body.correctable).toBe(false);
      const res = await correct(s, v.id, "no_show");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("money_taken");
      expect(res.body.message).toMatch(/refund it first/);
      const r = await row(v.id);
      expect(r.status).toBe("COMPLETED");
      expect(r.canceledAt).toBeNull();
      expect(await balance(s.shopId, v.clientId)).toBe(1);
    }
    expect(refundForCancellation).not.toHaveBeenCalled();
    expect(settleCardOnFile).not.toHaveBeenCalled();
    expect(stripeClient).not.toHaveBeenCalled();
    await expectNobodyTold(s.shopId);
  });

  it("🔴 a deposit-paid no-show: NO_SHOW, the deposit row untouched, no Stripe, and Refund deposit opens", async () => {
    const s = await makeShop("CCV deposit no-show");
    const v = await autoCompleted(s);
    await payment(s, v.id, "booking", "succeeded");
    const deposit = () =>
      prisma.payment.findFirstOrThrow({
        where: { appointmentId: v.id, purpose: "booking" },
        select: {
          status: true,
          amount: true,
          capturedAmount: true,
          refundedAmount: true,
          applicationFeeAmount: true,
          updatedAt: true,
        },
      });
    const before = await deposit();
    const refundDeposit = () =>
      request(app)
        .post(`/api/booking/appointments/${v.id}/deposit-refund`)
        // Deliberately the wrong figure: the answer shows how far the refund
        // got WITHOUT ever reaching Stripe.
        .send({ amountCents: 1 })
        .set("Cookie", s.cookie);

    expect((await detail(s, v.id)).body.correctable).toBe(true);
    // While it is completed, Refund deposit is closed to it.
    const closed = await refundDeposit();
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ error: "not_refundable", reason: "booking_open" });

    const res = await correct(s, v.id, "no_show");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyCorrected: false });
    expect((await row(v.id)).status).toBe("NO_SHOW");
    expect(await balance(s.shopId, v.clientId)).toBe(0);
    // Kept exactly as it was: no refund, no capture, no fee.
    expect(await deposit()).toEqual(before);
    expect(await prisma.payment.count({ where: { appointmentId: v.id } })).toBe(1);
    // A no-show earns what it kept, and nothing for the cut.
    expect(await takings(s.shopId)).toBe(1000);
    expect((await detail(s, v.id)).body.keptDeposit).toEqual({
      amountCents: 1000,
      nonRefundable: false,
    });
    expect(refundForCancellation).not.toHaveBeenCalled();
    expect(settleCardOnFile).not.toHaveBeenCalled();
    expect(releaseCardOnFile).not.toHaveBeenCalled();
    expect(stripeClient).not.toHaveBeenCalled();
    await expectNobodyTold(s.shopId);

    // Now the shop's own Refund deposit can give it back if it chooses: past
    // the status gate, stopped only by the deliberately wrong figure.
    const open = await refundDeposit();
    expect(open.status).toBe(409);
    expect(open.body).toEqual({ error: "amount_changed", refundableCents: 1000 });
    expect(stripeClient).not.toHaveBeenCalled();
    expect(await deposit()).toEqual(before);
  });

  it("🔴 a deposit-paid visit is NOT cancelled here (that would owe a refund) and says to use Mark no-show", async () => {
    const s = await makeShop("CCV deposit cancel");
    const v = await autoCompleted(s);
    await payment(s, v.id, "booking", "succeeded");
    const before = await prisma.payment.findFirstOrThrow({ where: { appointmentId: v.id } });
    const res = await correct(s, v.id, "canceled");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("deposit_paid");
    expect(res.body.message).toMatch(/use Mark no-show instead/);
    const r = await row(v.id);
    expect(r.status).toBe("COMPLETED");
    expect(r.canceledAt).toBeNull();
    expect(r.cancellationRevision).toBe(0);
    expect(await balance(s.shopId, v.clientId)).toBe(1);
    expect(await prisma.payment.findFirstOrThrow({ where: { appointmentId: v.id } })).toEqual(before);
    expect(refundForCancellation).not.toHaveBeenCalled();
    expect(stripeClient).not.toHaveBeenCalled();
    await expectNobodyTold(s.shopId);
  });

  it("a tip still refuses both corrections, deposit or not", async () => {
    const s = await makeShop("CCV tip");
    for (const withDeposit of [false, true]) {
      const v = await autoCompleted(s);
      if (withDeposit) await payment(s, v.id, "booking", "succeeded");
      await payment(s, v.id, "tip", "succeeded");
      expect((await detail(s, v.id)).body.correctable).toBe(false);
      for (const outcome of ["no_show", "canceled"] as const) {
        const res = await correct(s, v.id, outcome);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("money_taken");
      }
      expect((await row(v.id)).status).toBe("COMPLETED");
      expect(await balance(s.shopId, v.clientId)).toBe(1);
    }
    expect(stripeClient).not.toHaveBeenCalled();
  });

  it("🔴 inside the transaction the deposit is kept only for a NO-SHOW that asked to keep it", async () => {
    const s = await makeShop("CCV deposit engine");
    const opts = { onlyFrom: ["COMPLETED" as const], silent: true, refuseIfMoney: true };
    const v = await autoCompleted(s);
    await payment(s, v.id, "booking", "succeeded");
    // A cancel refuses over it even when told to keep a deposit...
    await expect(
      cancelAppointment(s.shopId, v.id, "CANCELED", new Date(), { ...opts, keepBookingPayment: true }),
    ).rejects.toBeInstanceOf(CancelRefusedError);
    // ...and a no-show that did not ask (remove-walk-in's shape) refuses too.
    await expect(
      cancelAppointment(s.shopId, v.id, "NO_SHOW", new Date(), opts),
    ).rejects.toBeInstanceOf(CancelRefusedError);
    expect((await row(v.id)).status).toBe("COMPLETED");
    await expect(
      cancelAppointment(s.shopId, v.id, "NO_SHOW", new Date(), { ...opts, keepBookingPayment: true }),
    ).resolves.toBe(true);
    expect((await row(v.id)).status).toBe("NO_SHOW");
    expect(refundForCancellation).not.toHaveBeenCalled();
    expect(stripeClient).not.toHaveBeenCalled();
  });

  it("lets a visit go whose only payment attempt died", async () => {
    const s = await makeShop("CCV dead pay");
    const v = await autoCompleted(s);
    await payment(s, v.id, "tip", "canceled");
    expect((await detail(s, v.id)).body.correctable).toBe(true);
    expect((await correct(s, v.id, "no_show")).status).toBe(200);
    expect((await row(v.id)).status).toBe("NO_SHOW");
  });

  it("refuses a visit checked out at the chair", async () => {
    const s = await makeShop("CCV checked out");
    const v = await autoCompleted(s);
    await prisma.appointment.update({
      where: { id: v.id },
      data: { paidAt: new Date(), paidAmount: 40, paidMethod: "cash" },
    });
    expect((await detail(s, v.id)).body.correctable).toBe(false);
    const res = await correct(s, v.id, "canceled");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("checked_out");
    expect(res.body.message).toMatch(/checked out/);
    expect((await row(v.id)).status).toBe("COMPLETED");
    expect(await balance(s.shopId, v.clientId)).toBe(1);
  });

  it("🔴 the engine re-checks the checkout INSIDE its own transaction: a checkout saved after the route read it still refuses", async () => {
    const s = await makeShop("CCV checkout race");
    const v = await autoCompleted(s);
    // The route's read saw it unpaid; the checkout landed after. The engine
    // must refuse on its own, under the row lock, and roll back.
    await prisma.appointment.update({
      where: { id: v.id },
      data: { paidAt: new Date(), paidAmount: 40, paidMethod: "cash" },
    });
    await expect(
      cancelAppointment(s.shopId, v.id, "NO_SHOW", new Date(), {
        onlyFrom: ["COMPLETED"],
        silent: true,
        refuseIfMoney: true,
        refuseIfCheckedOut: true,
      }),
    ).rejects.toBeInstanceOf(CancelRefusedError);
    expect((await row(v.id)).status).toBe("COMPLETED");
    expect(await balance(s.shopId, v.clientId)).toBe(1);
  });

  it("never reaches another shop's visit", async () => {
    const a = await makeShop("CCV A");
    const b = await makeShop("CCV B");
    const v = await autoCompleted(a);
    const res = await correct(b, v.id, "no_show");
    expect(res.status).toBe(404);
    expect((await row(v.id)).status).toBe("COMPLETED");
    expect(await takings(a.shopId)).toBe(4000);
  });

  it("refuses a booking that is not completed, and leaves /no-show and /cancel as they were", async () => {
    const s = await makeShop("CCV not completed");
    const booked = await prisma.appointment.create({
      data: {
        shopId: s.shopId,
        staffId: s.staffId,
        serviceId: s.serviceId,
        firstName: "Pat",
        startsAt: new Date(Date.now() + DAY),
        endsAt: new Date(Date.now() + DAY + 30 * 60_000),
        priceAtBooking: 40,
        status: "BOOKED",
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const res = await correct(s, booked.id, "no_show");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_completed");
    expect((await row(booked.id)).status).toBe("BOOKED");

    // An ordinary cancel of a BOOKED one, then a correction to "canceled": it
    // was never completed, so there is nothing to put right.
    expect(
      (await request(app)
        .post(`/api/booking/appointments/${booked.id}/cancel`)
        .set("Cookie", s.cookie)).status,
    ).toBe(200);
    const cancelled = await correct(s, booked.id, "canceled");
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error).toBe("not_completed");

    // /no-show still refuses a completed visit, exactly as before.
    const v = await autoCompleted(s);
    const noShow = await request(app)
      .post(`/api/booking/appointments/${v.id}/no-show`)
      .set("Cookie", s.cookie);
    expect(noShow.status).toBe(409);
    expect(noShow.body.error).toBe("not_booked");

    const bad = await request(app)
      .post(`/api/booking/appointments/${v.id}/correct-completed`)
      .set("Cookie", s.cookie)
      .send({ outcome: "completed" });
    expect(bad.status).toBe(400);
  });

  it("a corrected cancel is not brought back by restore (it would return as an upcoming booking)", async () => {
    const s = await makeShop("CCV restore");
    const v = await autoCompleted(s);
    expect((await correct(s, v.id, "canceled")).status).toBe(200);
    const res = await request(app)
      .post(`/api/booking/appointments/${v.id}/restore`)
      .set("Cookie", s.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_restorable");
    expect((await row(v.id)).status).toBe("CANCELED");
    expect(await balance(s.shopId, v.clientId)).toBe(0);
  });

  it("🔴 restore refuses a once-completed cancel even with no loyalty Visit linked", async () => {
    const s = await makeShop("CCV restore no visit");
    const v = await autoCompleted(s);
    expect((await correct(s, v.id, "canceled")).status).toBe(200);
    // Without completedAt the visitId guard is all that stood here.
    await prisma.appointment.update({ where: { id: v.id }, data: { visitId: null } });
    const res = await request(app)
      .post(`/api/booking/appointments/${v.id}/restore`)
      .set("Cookie", s.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_restorable");
    expect((await row(v.id)).status).toBe("CANCELED");
  });
});
