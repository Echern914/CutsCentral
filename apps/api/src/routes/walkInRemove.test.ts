import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * POST /api/booking/appointments/:id/remove-walk-in - a shop owner: "It doesn't
 * let someone change a walk-in or cancel it ... I'd like to be able to remove
 * it from the schedule."
 *
 * A walk-in is a receipt, born COMPLETED and paid. Removing one recorded by
 * mistake is a CORRECTION, so what matters is everything it must NOT do:
 *   - tell anybody (no email intent, no text, no push, no Wallet poke, no
 *     slot-opened alert, no Auto-fill run);
 *   - move money (a walk-in with a live card payment or tip is refused, with
 *     nothing changed - it is never refunded from here);
 *   - reach another shop, or any booking that is not a ChairBack walk-in.
 * And what it must do: leave the schedule and the takings (the ONE revenue
 * read, readChairEvents), and give back any punches through the ledger.
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
const settleCardOnFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/cardOnFileSettle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cardOnFileSettle.js")>()),
  settleCardOnFile,
}));

const { createApp } = await import("../app.js");
const { promoteOneAppointmentInTx } = await import("../engines/appointmentPromotion.js");
const { readChairEvents } = await import("../engines/insightsWindow.js");
const { __setMessageProviderForTests } = await import("../messaging/twilio.js");
const { __setPushSenderForTests } = await import("../messaging/push.js");

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

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
  notifySlotOpened.mockClear();
  pokeAppointmentPass.mockClear();
  refundForCancellation.mockClear();
  settleCardOnFile.mockClear();
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
  const email = `wirm-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://wirm.test", smsAttested: true });
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
    },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Solo" }, select: { id: true } });
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: svc.id };
}

async function recordWalkIn(s: Shop, amount = 40): Promise<string> {
  const res = await request(app)
    .post("/api/booking/appointments/walk-in")
    .set("Cookie", s.cookie)
    .send({ amount });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const remove = (s: Shop, id: string) =>
  request(app).post(`/api/booking/appointments/${id}/remove-walk-in`).set("Cookie", s.cookie);

const row = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      canceledAt: true,
      dismissedAt: true,
      cancellationRevision: true,
      paidAmount: true,
      visitId: true,
    },
  });

async function takings(shopId: string): Promise<number> {
  const now = Date.now();
  const { events } = await readChairEvents(
    shopId,
    new Date(now - 2 * 86_400_000),
    new Date(now + 2 * 86_400_000),
  );
  return events.reduce((sum, e) => sum + e.earnedCents, 0);
}

/** Whether the barber's day view still shows this row. */
async function onAgenda(s: Shop, id: string): Promise<boolean> {
  const agenda = await request(app)
    .get("/api/booking/agenda")
    .query({
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
    })
    .set("Cookie", s.cookie);
  expect(agenda.status).toBe(200);
  return JSON.stringify(agenda.body).includes(id);
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

/** And no money moved. */
function expectNoMoneyMoved() {
  expect(refundForCancellation).not.toHaveBeenCalled();
  expect(settleCardOnFile).not.toHaveBeenCalled();
}

async function payment(
  s: Shop,
  appointmentId: string,
  opts: { purpose: string; status: string; mode?: "ahead" | "terminal" },
) {
  await prisma.payment.create({
    data: {
      shopId: s.shopId,
      appointmentId,
      stripePaymentIntentId: `pi_${randomToken(14)}`,
      stripeConnectAccountId: "acct_test_wirm",
      mode: opts.mode ?? "ahead",
      purpose: opts.purpose,
      amount: 800,
      status: opts.status,
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

describe("remove a walk-in", () => {
  it("takes it off the schedule and out of the takings, telling nobody", async () => {
    const s = await makeShop("Remove WI");
    const id = await recordWalkIn(s, 40);

    // The sheet is told by the server, never by a service name.
    const before = await request(app)
      .get(`/api/booking/appointments/${id}/detail`)
      .set("Cookie", s.cookie);
    expect(before.status).toBe(200);
    expect(before.body.walkIn).toBe(true);
    expect(await takings(s.shopId)).toBe(4000);
    expect(await onAgenda(s, id)).toBe(true);

    const res = await remove(s, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyRemoved: false });

    const r = await row(id);
    expect(r.status).toBe("CANCELED");
    expect(r.canceledAt).not.toBeNull();
    // Off the day view, not just greyed out on it.
    expect(r.dismissedAt).not.toBeNull();
    // The record stays: nothing is deleted, the money is simply not counted.
    expect(Number(r.paidAmount)).toBe(40);
    expect(await takings(s.shopId)).toBe(0);

    expect(await onAgenda(s, id)).toBe(false);

    await expectNobodyTold(s.shopId);
    expectNoMoneyMoved();
  });

  it("gives back the punches it earned through the ledger, and still tells nobody", async () => {
    const s = await makeShop("Remove WI punches");
    const id = await recordWalkIn(s, 35);
    // Today's walk-in never earns (it has no client). A walk-in that HAD
    // earned - a client attached and the visit promoted - is the case the
    // clawback exists for, and the one where a cancellation email WOULD go:
    // this client has an address.
    const client = await prisma.client.create({
      data: {
        shopId: s.shopId,
        firstName: "Sample",
        email: `wirm-client-${randomToken(5)}@test.chairback`.toLowerCase(),
        acuityClientKey: `wirm-${randomToken(8)}`,
        magicToken: randomToken(),
      },
      select: { id: true },
    });
    await prisma.appointment.update({ where: { id }, data: { clientId: client.id } });
    const a = await prisma.appointment.findUniqueOrThrow({
      where: { id },
      select: { startsAt: true, endsAt: true },
    });
    const outcome = await runWithShop(s.shopId, (tx) =>
      promoteOneAppointmentInTx(
        tx,
        { id: s.shopId, punchesPerVisit: 1 },
        {
          id,
          clientId: client.id,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          priceAtBooking: null,
          serviceName: "Walk-in",
        },
        new Date(),
        { byShop: true },
      ),
    );
    expect(outcome.promoted && outcome.earn?.earned).toBe(1);
    expect(await balance(s.shopId, client.id)).toBe(1);
    const visitId = (await row(id)).visitId!;
    expect(visitId).toBeTruthy();

    const res = await remove(s, id);
    expect(res.status).toBe(200);

    expect(await balance(s.shopId, client.id)).toBe(0);
    // Reversed, not edited: the earn row stands and a reversal offsets it.
    const ledger = await prisma.punchLedger.findMany({
      where: { shopId: s.shopId, clientId: client.id },
      select: { visitId: true, punchesEarned: true, punchesRedeemed: true, reversalOfId: true },
    });
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((l) => l.reversalOfId !== null)).toHaveLength(1);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).status).toBe(
      "CANCELED",
    );

    await expectNobodyTold(s.shopId);
    expectNoMoneyMoved();
  });

  it("a second remove is a no-op answer, not an error", async () => {
    const s = await makeShop("Remove WI twice");
    const id = await recordWalkIn(s);
    expect((await remove(s, id)).status).toBe(200);
    const first = await row(id);

    const again = await remove(s, id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, alreadyRemoved: true });
    const second = await row(id);
    expect(second.canceledAt?.getTime()).toBe(first.canceledAt?.getTime());
    expect(second.cancellationRevision).toBe(first.cancellationRevision);
    await expectNobodyTold(s.shopId);
  });

  it("refuses a walk-in with a card payment or a tip, and changes nothing", async () => {
    const s = await makeShop("Remove WI money");
    for (const p of [
      { purpose: "tip", status: "succeeded" },
      { purpose: "service_checkout", status: "succeeded", mode: "terminal" as const },
      // A tip the client opened and could still pay is money in flight.
      { purpose: "tip", status: "requires_payment_method" },
    ]) {
      const id = await recordWalkIn(s);
      await payment(s, id, p);
      const res = await remove(s, id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("money_taken");
      expect(res.body.message).toMatch(/Refund it first/);
      const r = await row(id);
      expect(r.status).toBe("COMPLETED");
      expect(r.canceledAt).toBeNull();
      expect(r.dismissedAt).toBeNull();
      expect(r.cancellationRevision).toBe(0);
    }
    expectNoMoneyMoved();
    await expectNobodyTold(s.shopId);
  });

  it("lets a walk-in go whose only payment attempt died", async () => {
    const s = await makeShop("Remove WI dead pay");
    const id = await recordWalkIn(s);
    await payment(s, id, { purpose: "tip", status: "canceled" });
    expect((await remove(s, id)).status).toBe(200);
    expect((await row(id)).status).toBe("CANCELED");
    expectNoMoneyMoved();
  });

  it("refuses anything that is not a ChairBack walk-in", async () => {
    const s = await makeShop("Remove WI not");
    const walkInService = await prisma.appointment.findUniqueOrThrow({
      where: { id: await recordWalkIn(s) },
      select: { serviceId: true },
    });
    const base = {
      shopId: s.shopId,
      staffId: s.staffId,
      startsAt: new Date(Date.now() - 3 * 3_600_000),
      endsAt: new Date(Date.now() - 2.5 * 3_600_000),
      priceAtBooking: 40,
    };
    const cases = [
      // A client's booking, upcoming and finished.
      { ...base, serviceId: s.serviceId, firstName: "Pat", status: "BOOKED" as const },
      { ...base, serviceId: s.serviceId, firstName: "Pat", status: "COMPLETED" as const },
      // Named "Walk-in" by hand, but booked for a real service.
      { ...base, serviceId: s.serviceId, firstName: "Walk-in", status: "COMPLETED" as const },
      // The walk-in service, but a real person's name: not the quick log.
      { ...base, serviceId: walkInService.serviceId, firstName: "Pat", status: "COMPLETED" as const },
      // Both markers, but it came in through a booking channel.
      {
        ...base,
        serviceId: walkInService.serviceId,
        firstName: "Walk-in",
        status: "COMPLETED" as const,
        bookedVia: "online",
      },
    ];
    for (const data of cases) {
      const a = await prisma.appointment.create({
        data: { ...data, manageToken: randomToken() },
        select: { id: true },
      });
      const detail = await request(app)
        .get(`/api/booking/appointments/${a.id}/detail`)
        .set("Cookie", s.cookie);
      expect(detail.body.walkIn).toBe(false);
      const res = await remove(s, a.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("not_a_walk_in");
      const r = await row(a.id);
      expect(r.status).toBe(data.status);
      expect(r.canceledAt).toBeNull();
    }
    await expectNobodyTold(s.shopId);
  });

  it("never reaches another shop's walk-in", async () => {
    const a = await makeShop("Remove WI A");
    const b = await makeShop("Remove WI B");
    const id = await recordWalkIn(a);
    const res = await remove(b, id);
    expect(res.status).toBe(404);
    expect((await row(id)).status).toBe("COMPLETED");
    expect(await takings(a.shopId)).toBe(4000);
  });

  it("a removed walk-in is not brought back by restore (it would return as a booking)", async () => {
    const s = await makeShop("Remove WI restore");
    const id = await recordWalkIn(s);
    expect((await remove(s, id)).status).toBe(200);
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/restore`)
      .set("Cookie", s.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_restorable");
    const r = await row(id);
    expect(r.status).toBe("CANCELED");
    expect(r.dismissedAt).not.toBeNull();
  });
});
