import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { promoteFulfilledAppointments } from "../engines/appointmentPromotion.js";
import { runAppointmentReminders } from "../engines/appointmentReminders.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import { createApp } from "../app.js";

/**
 * End-to-end native booking: a shop configures staff/service/availability, a
 * customer self-books an open slot (consent + confirmation SMS), the appointment
 * promotes into a COMPLETED Visit + punch, the reminder fires once, and the
 * double-booking guard / consent / tenant isolation all hold.
 */
const app = createApp();
const emailA = `book-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `book-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let slugA: string;
let staffId: string;
let serviceId: string;

let sent: SendMessageInput[] = [];

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

async function signupAndShop(email: string, name: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Book", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return cookie;
}

/** A future instant (UTC) at the given hour, `daysAhead` days from now. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/**
 * A fixed "now" at 15:00 UTC today - comfortably inside the 8am-9pm quiet-hours
 * window for the UTC-timezone test shop, so SMS gates aren't time-of-day flaky.
 * Used wherever a notify/promote path checks quiet hours.
 */
function middayNow(): Date {
  const d = new Date();
  d.setUTCHours(15, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `SM-fake-${sent.length}`, status: "queued" };
    },
  });

  cookieA = await signupAndShop(emailA, "Book Cuts A");
  cookieB = await signupAndShop(emailB, "Book Cuts B");

  // Shop A: native mode, UTC timezone (so wall-clock == UTC in the test math),
  // small lead time so "tomorrow" is bookable.
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookieA)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);
  expect(patch.body.bookingMode).toBe("native");

  const me = await request(app).get("/api/shops/me").set("Cookie", cookieA);
  slugA = me.body.slug;

  // One staff member.
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookieA)
    .send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;

  // One 30-min service, offered by Sam.
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookieA)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;

  // Availability: every weekday 09:00-17:00 (local == UTC here).
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  }));
  const avail = await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookieA)
    .send({ rules });
  expect(avail.status).toBe(200);
});

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("public booking surface", () => {
  it("exposes staff + services for a native shop", async () => {
    const res = await request(app).get(`/api/book/${slugA}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.timezone).toBe("UTC");
    expect(res.body.staff).toHaveLength(1);
    expect(res.body.services[0].name).toBe("Haircut");
    expect(res.body.services[0].price).toBe(35);
  });

  it("404s for an unknown slug", async () => {
    const res = await request(app).get(`/api/book/no-such-shop`);
    expect(res.status).toBe(404);
  });

  it("returns open slots within availability", async () => {
    const from = futureAtHour(1, 0).toISOString();
    const to = futureAtHour(2, 0).toISOString();
    const res = await request(app)
      .get(`/api/book/${slugA}/slots`)
      .query({ staffId, serviceId, from, to });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    // First slot of the day starts at 09:00 UTC.
    const first = new Date(res.body.slots[0].startsAt);
    expect(first.getUTCHours()).toBe(9);
  });
});

describe("creating a booking", () => {
  it("books an open slot, stamps consent, and sends a confirmation", async () => {
    const startsAt = futureAtHour(1, 10).toISOString(); // 10:00 tomorrow
    const res = await request(app)
      .post(`/api/book/${slugA}`)
      .send({
        staffId,
        serviceId,
        startsAt,
        firstName: "Casey",
        phone: "(302) 555-0400",
        smsConsent: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.manageToken).toBeTruthy();

    // The client was created with booking-sourced consent.
    const client = await prisma.client.findFirst({
      where: { phone: "+13025550400" },
      select: { smsConsentAt: true, smsConsentSource: true },
    });
    expect(client?.smsConsentAt).not.toBeNull();
    expect(client?.smsConsentSource).toBe("booking");

    // The confirmation send (gate: consent + not quiet hours). The route fires it
    // fire-and-forget at real `now`, which may be quiet hours in CI; drive it
    // directly with a midday `now` so the assertion is deterministic. Idempotent
    // via confirmationSentAt, so this is the single send either way.
    const appt = await prisma.appointment.findFirst({
      where: { phone: "+13025550400" },
      select: { id: true, shopId: true },
    });
    sent = [];
    await notifyAppointmentConfirmation({
      shopId: appt!.shopId,
      appointmentId: appt!.id,
      now: middayNow(),
    });
    expect(sent.some((s) => s.body.includes("Casey"))).toBe(true);
  });

  it("rejects a slot too far in the future", async () => {
    const startsAt = futureAtHour(400, 10).toISOString();
    const res = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId, startsAt, firstName: "Far", phone: "(302) 555-0401" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("too_far");
  });

  it("rejects a slot OUTSIDE the staff's hours (write-path availability guard)", async () => {
    // 03:00 is outside the 09:00-17:00 availability - the slot picker would never
    // offer it, and a crafted POST must be refused (not just trust the browser).
    const startsAt = futureAtHour(2, 3).toISOString();
    const res = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId, startsAt, firstName: "OffHours", phone: "(302) 555-0410" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
  });

  it("rejects a slot on a blocked exception day (vacation)", async () => {
    // Block the whole of day+5 for this staff, then try to book inside it.
    const dayStart = futureAtHour(5, 0);
    const dayEnd = futureAtHour(6, 0);
    const ex = await request(app)
      .post(`/api/booking/staff/${staffId}/exceptions`)
      .set("Cookie", cookieA)
      .send({
        startsAt: dayStart.toISOString(),
        endsAt: dayEnd.toISOString(),
        isBlock: true,
        reason: "Vacation",
      });
    expect(ex.status).toBe(201);

    const startsAt = futureAtHour(5, 10).toISOString(); // 10:00 on the blocked day
    const res = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId, startsAt, firstName: "Blocked", phone: "(302) 555-0411" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
  });

  it("409s when the same slot is grabbed twice", async () => {
    const startsAt = futureAtHour(2, 11).toISOString();
    const first = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId, startsAt, firstName: "One", phone: "(302) 555-0402" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId, startsAt, firstName: "Two", phone: "(302) 555-0403" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("slot_taken");
  });

  it("books cleanly under DRY_RUN (send routes to the noop provider)", async () => {
    // The injected fake always wins over DRY_RUN (getMessageProvider returns the
    // test provider first), so to exercise the real DRY_RUN -> NoopProvider path
    // we REMOVE the fake for this test. The assertion is that the booking still
    // succeeds and nothing throws (the noop provider swallows the send). The fake
    // is restored afterwards for the remaining tests.
    process.env.DRY_RUN = "true";
    __resetEnvCacheForTests();
    __setMessageProviderForTests(undefined);
    try {
      const startsAt = futureAtHour(2, 13).toISOString();
      const res = await request(app)
        .post(`/api/book/${slugA}`)
        .send({
          staffId,
          serviceId,
          startsAt,
          firstName: "Dry",
          phone: "(302) 555-0404",
          smsConsent: true,
        });
      expect(res.status).toBe(201);
      // Let the fire-and-forget confirmation run; under DRY_RUN it hits the noop
      // provider, so no real Twilio call is made and the flow stays green.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.env.DRY_RUN = "false";
      __resetEnvCacheForTests();
      __setMessageProviderForTests({
        channel: "SMS",
        send: async (input) => {
          sent.push(input);
          return { sid: `SM-fake-${sent.length}`, status: "queued" };
        },
      });
    }
  });
});

describe("appointment promotion + loyalty", () => {
  it("promotes a past appointment into a COMPLETED visit that earns a punch", async () => {
    // Turn loyalty texts on so the earn notification can fire.
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ loyaltyTextsEnabled: true });

    // Book a slot, then move it into the past so the promotion job picks it up.
    const startsAt = futureAtHour(3, 12).toISOString();
    const booking = await request(app)
      .post(`/api/book/${slugA}`)
      .send({
        staffId,
        serviceId,
        startsAt,
        firstName: "Pat",
        phone: "(302) 555-0500",
        smsConsent: true,
      });
    expect(booking.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { phone: "+13025550500" },
      select: { id: true, clientId: true },
    });
    expect(appt).toBeTruthy();
    // Move it clearly into the past relative to our fixed `now` (midday today).
    const now = middayNow();
    const past = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await prisma.appointment.update({
      where: { id: appt!.id },
      data: { startsAt: past, endsAt: new Date(past.getTime() + 30 * 60 * 1000) },
    });

    sent = [];
    const count = await promoteFulfilledAppointments(now);
    expect(count).toBeGreaterThanOrEqual(1);

    // A COMPLETED Visit keyed by booking:{id} exists, with a punch.
    const visit = await prisma.visit.findFirst({
      where: { acuityAppointmentId: `booking:${appt!.id}` },
      select: { id: true, status: true },
    });
    expect(visit?.status).toBe("COMPLETED");
    const punch = await prisma.punchLedger.findFirst({
      where: { visitId: visit!.id },
    });
    expect(punch?.punchesEarned).toBe(1);
    // The earn text fired.
    expect(sent.some((s) => s.body.toLowerCase().includes("punch"))).toBe(true);

    // Re-running is idempotent: no second punch.
    const again = await promoteFulfilledAppointments(new Date());
    expect(again).toBe(0);
    const punchCount = await prisma.punchLedger.count({
      where: { visitId: visit!.id },
    });
    expect(punchCount).toBe(1);
  });

  it("claws back the punch when a promoted appointment is canceled", async () => {
    const appt = await prisma.appointment.findFirst({
      where: { phone: "+13025550500" },
      select: { id: true, visitId: true, clientId: true },
    });
    expect(appt?.visitId).toBeTruthy();

    const cancel = await request(app)
      .post(`/api/booking/appointments/${appt!.id}/cancel`)
      .set("Cookie", cookieA);
    expect(cancel.status).toBe(200);

    const punchCount = await prisma.punchLedger.count({
      where: { visitId: appt!.visitId! },
    });
    expect(punchCount).toBe(0);
  });
});

describe("appointment reminders", () => {
  it("sends a reminder once for an appointment within 24h, then stays silent", async () => {
    // Book a valid in-hours slot tomorrow at 12:00 UTC.
    const tomorrowNoon = futureAtHour(1, 12);
    const booking = await request(app)
      .post(`/api/book/${slugA}`)
      .send({
        staffId,
        serviceId,
        startsAt: tomorrowNoon.toISOString(),
        firstName: "Remy",
        phone: "(302) 555-0600",
        smsConsent: true,
      });
    expect(booking.status).toBe(201);

    // Remind from a fixed "now" at 15:00 UTC today: that is in the 8am-9pm window
    // (no quiet-hours defer), before the appointment, and within 24h of it.
    const remindNow = middayNow();

    sent = [];
    const firstRun = await runAppointmentReminders(remindNow);
    expect(firstRun).toBeGreaterThanOrEqual(1);
    expect(sent.some((s) => s.body.includes("Remy"))).toBe(true);

    // A second run sends nothing (reminderSentAt is stamped).
    sent = [];
    await runAppointmentReminders(remindNow);
    expect(sent.some((s) => s.body.includes("Remy"))).toBe(false);
  });
});

describe("manage by token + tenant isolation", () => {
  it("lets the customer cancel via their manage token", async () => {
    const startsAt = futureAtHour(4, 14).toISOString();
    const booking = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId, startsAt, firstName: "Mona", phone: "(302) 555-0700" });
    expect(booking.status).toBe(201);
    const token = booking.body.manageToken;

    const view = await request(app).get(`/api/book/manage/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.canCancel).toBe(true);

    const cancel = await request(app).post(`/api/book/manage/${token}/cancel`);
    expect(cancel.status).toBe(200);

    const after = await request(app).get(`/api/book/manage/${token}`);
    expect(after.body.status).toBe("CANCELED");
  });

  it("hides shop A's appointments from shop B", async () => {
    const list = await request(app)
      .get("/api/booking/appointments")
      .set("Cookie", cookieB);
    expect(list.status).toBe(200);
    expect(list.body.appointments).toHaveLength(0);
  });

  it("404s the public booking surface when the shop isn't native", async () => {
    const meB = await request(app).get("/api/shops/me").set("Cookie", cookieB);
    const res = await request(app).get(`/api/book/${meB.body.slug}`);
    expect(res.status).toBe(404);
  });
});

describe("day-of-week pricing", () => {
  let premiumId: string;

  /** Next UTC date whose weekday == target, at hourUtc, at least minDaysAhead out.
   *  Defaults to 9 days out so these slots never collide with the other tests'
   *  bookings (which use day+1..day+5 on the same shared staff calendar). */
  function nextWeekdayAt(targetWeekday: number, hourUtc: number, minDaysAhead = 9): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + minDaysAhead);
    d.setUTCHours(hourUtc, 0, 0, 0);
    while (d.getUTCDay() !== targetWeekday) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  beforeAll(async () => {
    // $45 base, $55 on Sundays (weekday 0).
    const svc = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookieA)
      .send({
        name: "Premium Cut",
        durationMin: 30,
        price: 45,
        priceOverrides: { "0": 55 },
        staffIds: [staffId],
      });
    expect(svc.status).toBe(201);
    premiumId = svc.body.id;
  });

  it("exposes overrides + a price range on the public menu", async () => {
    const res = await request(app).get(`/api/book/${slugA}`);
    const svc = res.body.services.find((s: { id: string }) => s.id === premiumId);
    expect(svc.price).toBe(45);
    expect(svc.priceOverrides).toEqual({ "0": 55 });
    expect(svc.priceRange).toEqual({ min: 45, max: 55 });
  });

  it("snapshots the SUNDAY price ($55) when booking on a Sunday", async () => {
    const sunday = nextWeekdayAt(0, 10); // Sunday 10:00 UTC, in 09-17 window
    const res = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId: premiumId, startsAt: sunday.toISOString(), firstName: "SunPay", phone: "(302) 555-0801" });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { phone: "+13025550801" },
      select: { priceAtBooking: true },
    });
    expect(Number(appt!.priceAtBooking)).toBe(55);
  });

  it("snapshots the BASE price ($45) on a non-Sunday", async () => {
    const saturday = nextWeekdayAt(6, 11); // Saturday 11:00 UTC
    const res = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId: premiumId, startsAt: saturday.toISOString(), firstName: "SatPay", phone: "(302) 555-0802" });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { phone: "+13025550802" },
      select: { priceAtBooking: true },
    });
    expect(Number(appt!.priceAtBooking)).toBe(45);
  });

  it("REPRICES to $55 when a Saturday booking is moved to a Sunday", async () => {
    const saturday = nextWeekdayAt(6, 13);
    const booking = await request(app)
      .post(`/api/book/${slugA}`)
      .send({ staffId, serviceId: premiumId, startsAt: saturday.toISOString(), firstName: "Mover", phone: "(302) 555-0803" });
    expect(booking.status).toBe(201);
    const token = booking.body.manageToken;

    const sunday = nextWeekdayAt(0, 13);
    const move = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: sunday.toISOString() });
    expect(move.status).toBe(200);

    const appt = await prisma.appointment.findFirst({
      where: { phone: "+13025550803" },
      select: { priceAtBooking: true },
    });
    expect(Number(appt!.priceAtBooking)).toBe(55);
  });
});
