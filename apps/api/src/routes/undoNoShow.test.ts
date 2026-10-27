import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A NO-SHOW MARKED BY MISTAKE, AND TAKING IT BACK (engines/noShowUndo.ts).
 *
 * A shop owner marked a FUTURE appointment a no-show by mistake and nothing
 * could put it back. Proven here:
 *   - a no-show is refused before the appointment starts, and a kept card is
 *     left exactly as it was (it used to be charged the fee at once);
 *   - once started, a no-show is recorded with who marked it;
 *   - Undo no-show puts it back to BOOKED, records who did it, and a second tap
 *     changes nothing;
 *   - if another booking took the time since, the undo is refused - never a
 *     double-booking;
 *   - money never moves: a fee already charged is left charged and SAID so;
 *     a charge still being confirmed refuses the undo;
 *   - a visit completed before it was corrected, an old one, and another
 *     shop's are refused;
 *   - the detail tells the sheet what it may offer.
 */
const app = createApp();
const password = "supersecret123";
const MIN = 60_000;
const emails: string[] = [];

async function makeShop(label: string) {
  const email = `noshow-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "NoShow", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://noshow.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadMinutes: 0 },
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({ data: { shopId, serviceId: service.id, staffId: staff.id } });
  return { cookie, shopId, userId: user.id, staffId: staff.id, serviceId: service.id };
}

type Shop = Awaited<ReturnType<typeof makeShop>>;

async function book(s: Shop, startsAt: Date, over: Record<string, unknown> = {}): Promise<string> {
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Pat",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * MIN),
      priceAtBooking: 40,
      manageToken: randomToken(),
      ...over,
    },
    select: { id: true },
  });
  return appt.id;
}

async function keepCard(s: Shop, appointmentId: string, status: string) {
  await prisma.cardOnFile.create({
    data: {
      id: `cof_${randomToken(8)}`,
      shopId: s.shopId,
      appointmentId,
      stripeCustomerId: `cus_${randomToken(6)}`,
      stripeSetupIntentId: `seti_${randomToken(10)}`,
      stripePaymentMethodId: `pm_${randomToken(6)}`,
      brand: "visa",
      last4: "4242",
      status,
      savedAt: new Date(),
    },
  });
}

const statusOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const changes = (id: string) =>
  prisma.appointmentStatusChange.findMany({ where: { appointmentId: id }, orderBy: { createdAt: "asc" } });
const noShow = (s: Shop, id: string) =>
  request(app).post(`/api/booking/appointments/${id}/no-show`).set("Cookie", s.cookie);
const undo = (s: Shop, id: string) =>
  request(app).post(`/api/booking/appointments/${id}/undo-no-show`).set("Cookie", s.cookie);
const detail = (s: Shop, id: string) =>
  request(app).get(`/api/booking/appointments/${id}/detail`).set("Cookie", s.cookie);

let S: Shop;

beforeAll(async () => {
  S = await makeShop("No Show Cuts");
});

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

describe("marking a no-show", () => {
  it("🔴 is refused before the appointment starts, and a kept card is left as it was", async () => {
    const id = await book(S, new Date(Date.now() + 26 * 60 * MIN));
    await keepCard(S, id, "saved");
    const res = await noShow(S, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_started");
    expect(res.body.message).toMatch(/hasn't started yet/);
    expect(await statusOf(id)).toBe("BOOKED");
    const card = await prisma.cardOnFile.findUniqueOrThrow({ where: { appointmentId: id } });
    expect(card.status).toBe("saved");
    expect(await changes(id)).toHaveLength(0);
  });

  it("once it has started: marked, with who marked it", async () => {
    const id = await book(S, new Date(Date.now() - 10 * MIN));
    const res = await noShow(S, id);
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("NO_SHOW");
    const rows = await changes(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "no_show", fromStatus: "BOOKED", toStatus: "NO_SHOW", actorUserId: S.userId });
  });

  it("the detail offers it only once the start has come", async () => {
    const future = await book(S, new Date(Date.now() + 3 * 60 * MIN));
    const started = await book(S, new Date(Date.now() - 2 * 60 * MIN), {});
    expect((await detail(S, future)).body.noShowAllowed).toBe(false);
    expect((await detail(S, started)).body.noShowAllowed).toBe(true);
  });
});

describe("undo no-show", () => {
  it("🔴 puts it back to BOOKED, records who did it, and a second tap changes nothing", async () => {
    const id = await book(S, new Date(Date.now() - 4 * 60 * MIN));
    expect((await noShow(S, id)).status).toBe(200);
    await prisma.appointment.update({ where: { id }, data: { dismissedAt: new Date() } });
    expect((await detail(S, id)).body.undoNoShow).toBe(true);

    const res = await undo(S, id);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Its time has passed: the sweep finishes it like any other booking.
    expect(res.body.notes).toContain(
      "Its time has passed, so it will be marked done shortly, like any finished appointment.",
    );
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("BOOKED");
    expect(row.dismissedAt).toBeNull();
    const rows = await changes(id);
    expect(rows.map((r) => r.kind)).toEqual(["no_show", "undo_no_show"]);
    expect(rows[1]).toMatchObject({ fromStatus: "NO_SHOW", toStatus: "BOOKED", actorUserId: S.userId });

    const again = await undo(S, id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("not_no_show");
    expect(await changes(id)).toHaveLength(2);
  });

  it("🔴 another booking now holds the time: refused, nothing double-booked", async () => {
    const start = new Date(Date.now() - 5 * MIN);
    const id = await book(S, start);
    expect((await noShow(S, id)).status).toBe(200);
    // The chair was given to someone else after the no-show freed it.
    await book(S, new Date(start.getTime() + 10 * MIN), { firstName: "Other" });
    const res = await undo(S, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    expect(res.body.message).toMatch(/Another booking now holds this time/);
    expect(await statusOf(id)).toBe("NO_SHOW");
    expect((await changes(id)).map((r) => r.kind)).toEqual(["no_show"]);
  });

  it("🔴 money never moves: a fee already charged stays charged, and is said so", async () => {
    const id = await book(S, new Date(Date.now() - 6 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    await keepCard(S, id, "charged");
    await prisma.payment.create({
      data: {
        shopId: S.shopId,
        appointmentId: id,
        purpose: "fee",
        stripePaymentIntentId: `pi_fee_${randomToken(8)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 2000,
        capturedAmount: 2000,
        status: "succeeded",
      },
    });
    const before = await prisma.payment.findMany({ where: { appointmentId: id } });
    const res = await undo(S, id);
    expect(res.status).toBe(200);
    expect(res.body.notes).toContain(
      "The $20 no-show fee charged to the card ending 4242 was not refunded. If it shouldn't stand, refund it in your Stripe dashboard.",
    );
    const after = await prisma.payment.findMany({ where: { appointmentId: id } });
    expect(after).toEqual(before);
  });

  it("a no-show charge still being confirmed refuses the undo until it settles", async () => {
    const id = await book(S, new Date(Date.now() - 7 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    await keepCard(S, id, "charging");
    const res = await undo(S, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("fee_pending");
    expect(await statusOf(id)).toBe("NO_SHOW");
    expect((await detail(S, id)).body.undoNoShow).toBe(false);
  });

  it("a visit completed before it was corrected to a no-show is refused (its punch was taken back)", async () => {
    const id = await book(S, new Date(Date.now() - 8 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW", completedAt: new Date() } });
    const res = await undo(S, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("was_completed");
  });

  it("one older than the correction window is refused", async () => {
    const id = await book(S, new Date(Date.now() - 9 * 24 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    const res = await undo(S, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("too_old");
  });

  it("a future booking marked a no-show before this shipped goes back as an upcoming booking", async () => {
    // A free time of its own (the first test leaves a booking 26 hours out).
    const id = await book(S, new Date(Date.now() + 50 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    const res = await undo(S, id);
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
    expect(await statusOf(id)).toBe("BOOKED");
  });

  it("🔴 a barber with a weekly break can still undo (the undo is the shop's own hand, like a restore)", async () => {
    const T = await makeShop("Break Cuts");
    // A lunch break every day, nowhere near the booking - and one that covers
    // it on another day of the week would not stop the shop either.
    await prisma.recurringBlock.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId: T.shopId,
        staffId: T.staffId,
        weekday,
        startMin: 12 * 60,
        endMin: 13 * 60,
      })),
    });
    const id = await book(T, new Date(Date.now() - 3 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    const res = await undo(T, id);
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("BOOKED");
  });

  it("another shop's appointment is not found", async () => {
    const T = await makeShop("Other Cuts");
    const id = await book(S, new Date(Date.now() - 3 * 60 * MIN));
    await prisma.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    const res = await undo(T, id);
    expect(res.status).toBe(404);
    expect(await statusOf(id)).toBe("NO_SHOW");
  });
});
