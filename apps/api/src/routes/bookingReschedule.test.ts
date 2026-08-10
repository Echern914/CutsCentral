import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * POST /api/booking/appointments/:id/reschedule — the barber moves a
 * booking he already has.
 *
 * The customer could already do this from the manage page; the barber, whose
 * calendar it actually is, could only cancel and rebook — which drops the
 * client's manage link and their reminders.
 *
 * The cases that matter:
 *   - `excludeAppointmentId` is LOAD-BEARING. Without it the appointment's own
 *     slot reads as busy and the barber can't nudge it 30 minutes, because it
 *     would be hiding its own hour.
 *   - `customTime` mirrors CREATE: it overrides the hours/blocked check and
 *     NEVER the overlap guard. No flag may double-book a chair.
 *   - the moved row is repriced and re-measured for the NEW instant, and its
 *     send-state is reset so the customer actually gets told.
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

/** Tomorrow at a given UTC hour — always future, never clock-dependent. */
function at(hour: number, minute = 0): Date {
  const d = new Date(Date.now() + DAY_MS);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute),
  );
}

async function makeShop(label: string) {
  const email = `resched-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Resched", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://r.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;

  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 },
  });
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId: staff.id },
  });
  // Open 09:00-17:00 every day, so 08:00 is deliberately OUTSIDE hours.
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}

async function book(
  s: Awaited<ReturnType<typeof makeShop>>,
  startsAt: Date,
): Promise<string> {
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Pat",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

const url = (id: string) => `/api/booking/appointments/${id}/reschedule`;

let S: Awaited<ReturnType<typeof makeShop>>;

beforeAll(async () => {
  S = await makeShop("Reschedule Cuts");
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

describe("barber reschedule", () => {
  it("moves a booking, re-measures its end, and resets send-state", async () => {
    const id = await book(S, at(10));
    await prisma.appointment.update({
      where: { id },
      data: { confirmationSentAt: new Date(), checkInStatus: "en_route" },
    });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ startsAt: at(14).toISOString() });
    expect(res.status).toBe(200);

    const row = await prisma.appointment.findUnique({ where: { id } });
    expect(row!.startsAt.toISOString()).toBe(at(14).toISOString());
    expect(row!.endsAt!.toISOString()).toBe(at(14, 30).toISOString());
    // Reset, or the moved booking silently never tells the customer and never
    // fires its 24h/2h reminders.
    expect(row!.confirmationSentAt).toBeNull();
    expect(row!.reminder24hPushSentAt).toBeNull();
    // An "en route" tapped for the OLD time says nothing about the new one.
    expect(row!.checkInStatus).toBeNull();
  });

  it("can move a booking WITHIN its own hour (excludeAppointmentId)", async () => {
    // THE TRAP. Without excludeAppointmentId the appointment's own slot counts
    // as busy, and nudging it 30 minutes is refused by the availability check —
    // the booking hides its own hour.
    const id = await book(S, at(11));
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ startsAt: at(11, 30).toISOString() });
    expect(res.status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id } });
    expect(row!.startsAt.toISOString()).toBe(at(11, 30).toISOString());
  });

  it("refuses a time outside opening hours, unless customTime is set", async () => {
    const id = await book(S, at(12));
    const outside = at(8).toISOString(); // shop opens at 09:00

    const refused = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ startsAt: outside });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_slot");

    // "Come in at 8, I'll open early" — the barber's own chair, his call.
    const forced = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ startsAt: outside, customTime: true });
    expect(forced.status).toBe(200);
  });

  it("customTime still cannot double-book the chair", async () => {
    // The override is about HOURS, never about overlap. Two clients in one
    // chair is the one thing no flag may produce.
    const held = await book(S, at(15));
    const moving = await book(S, at(16, 30));
    const res = await request(app)
      .post(url(moving))
      .set("Cookie", S.cookie)
      .send({ startsAt: at(15).toISOString(), customTime: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    // The blocker is untouched.
    const still = await prisma.appointment.findUnique({ where: { id: held } });
    expect(still!.startsAt.toISOString()).toBe(at(15).toISOString());
  });

  it("refuses a booking that is canceled or already past", async () => {
    const canceled = await book(S, at(13));
    await prisma.appointment.update({
      where: { id: canceled },
      data: { status: "CANCELED" },
    });
    const res = await request(app)
      .post(url(canceled))
      .set("Cookie", S.cookie)
      .send({ startsAt: at(14, 30).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_reschedulable");
  });

  it("cannot touch another shop's appointment", async () => {
    const other = await makeShop("Other Cuts");
    const theirs = await book(other, at(10));
    const res = await request(app)
      .post(url(theirs))
      .set("Cookie", S.cookie) // OUR session, THEIR appointment id
      .send({ startsAt: at(14).toISOString() });
    // 404, not 403: an id from another shop must not even be confirmed to exist.
    expect(res.status).toBe(404);
    const untouched = await prisma.appointment.findUnique({ where: { id: theirs } });
    expect(untouched!.startsAt.toISOString()).toBe(at(10).toISOString());
  });

  it("rejects a malformed body", async () => {
    const id = await book(S, at(9, 30));
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ startsAt: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });
});
