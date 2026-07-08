import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { promoteFulfilledAppointments } from "../engines/appointmentPromotion.js";
import { runAppointmentReminders } from "../engines/appointmentReminders.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import { createApp } from "../app.js";

/** A fixed midday UTC "now" - inside 8am-9pm quiet hours so SMS isn't time-flaky. */
function middayNow(): Date {
  const d = new Date();
  d.setUTCHours(15, 0, 0, 0);
  return d;
}

/**
 * Request-before-booking (requireBookingApproval): a public native booking lands
 * as PENDING, holds its slot, sends NO confirmation, and is never reminded or
 * promoted. The barber approves (→ BOOKED + confirmation fires) or declines
 * (→ CANCELED). SMS provider is faked so confirmation sends are observable.
 */
const app = createApp();
const email = `appr-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let staffId: string;
let serviceId: string;

let sent: SendMessageInput[] = [];
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function book(startsAt: Date, firstName: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({ staffId, serviceId, startsAt: startsAt.toISOString(), firstName, phone: "(302) 555-0400", smsConsent: true, ...overrides });
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `SM-${sent.length}`, status: "queued" };
    },
  });

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Appr", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Approval Cuts", smsAttested: true });
  // Native + timezone UTC + require approval ON.
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, requireBookingApproval: true });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  expect(me.body.requireBookingApproval).toBe(true);

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
});

afterEach(async () => {
  sent = [];
  await prisma.appointment.deleteMany({ where: { shop: { ownerId: (await ownerId()) } } });
});

async function ownerId(): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email } });
  return user!.id;
}

afterAll(async () => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("request-before-booking", () => {
  it("creates a PENDING request, sends NO confirmation, and flags pending", async () => {
    const res = await book(futureAtHour(1, 10), "Requester");
    expect(res.status).toBe(201);
    expect(res.body.pending).toBe(true);
    // No confirmation SMS on a request.
    expect(sent.length).toBe(0);
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Requester" } });
    expect(appt?.status).toBe("PENDING");
  });

  it("a PENDING request HOLDS its slot (a second booking at the same time 409s)", async () => {
    const at = futureAtHour(1, 11);
    const first = await book(at, "First");
    expect(first.status).toBe(201);
    const second = await book(at, "Second");
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("slot_taken");
  });

  it("the slot picker HIDES a slot with a PENDING request on it", async () => {
    const at = futureAtHour(1, 12);
    await book(at, "Holder");
    const from = futureAtHour(1, 0).toISOString();
    const to = futureAtHour(2, 0).toISOString();
    const slots = await request(app).get(`/api/book/${slug}/slots`).query({ staffId, serviceId, from, to });
    // The EXACT held instant must be gone (match by ISO, not just hour — an
    // adjacent day in the window legitimately still offers its own 12:00).
    const heldStillOffered = slots.body.slots.some(
      (s: { startsAt: string }) => s.startsAt === at.toISOString(),
    );
    expect(heldStillOffered).toBe(false);
  });

  it("approve flips PENDING → BOOKED and fires the confirmation", async () => {
    await book(futureAtHour(1, 13), "Approve Me");
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Approve Me" } });
    const approve = await request(app)
      .post(`/api/booking/appointments/${appt!.id}/approve`)
      .set("Cookie", cookie);
    expect(approve.status).toBe(200);
    const after = await prisma.appointment.findUnique({ where: { id: appt!.id } });
    expect(after?.status).toBe("BOOKED");
    // A second approve is idempotent (no PENDING row left) → 404.
    const again = await request(app).post(`/api/booking/appointments/${appt!.id}/approve`).set("Cookie", cookie);
    expect(again.status).toBe(404);
  });

  it("the approval confirmation is deliverable once BOOKED", async () => {
    // The create path skips the confirmation for a PENDING request (proven by
    // the "sends NO confirmation" test); approval makes it a normal BOOKED row,
    // and its confirmation then sends. Assert on a freshly-flipped row driven at
    // a midday now (no endpoint fire-and-forget in play, so no race).
    await book(futureAtHour(1, 13), "Deliver Me");
    const appt = await prisma.appointment.findFirst({
      where: { firstName: "Deliver Me" },
      select: { id: true, shopId: true },
    });
    await prisma.appointment.update({ where: { id: appt!.id }, data: { status: "BOOKED" } });
    sent = [];
    await notifyAppointmentConfirmation({ shopId: appt!.shopId, appointmentId: appt!.id, now: middayNow() });
    expect(sent.length).toBe(1);
  });

  it("decline flips PENDING → CANCELED (no confirmation)", async () => {
    await book(futureAtHour(1, 14), "Decline Me");
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Decline Me" } });
    sent = [];
    const decline = await request(app)
      .post(`/api/booking/appointments/${appt!.id}/decline`)
      .set("Cookie", cookie);
    expect(decline.status).toBe(200);
    const after = await prisma.appointment.findUnique({ where: { id: appt!.id } });
    expect(after?.status).toBe("CANCELED");
    expect(sent.length).toBe(0);
    // Second decline → 404 (no PENDING row).
    const again = await request(app).post(`/api/booking/appointments/${appt!.id}/decline`).set("Cookie", cookie);
    expect(again.status).toBe(404);
  });

  it("no-show REJECTS a PENDING request (can't no-show an unapproved hold)", async () => {
    await book(futureAtHour(1, 15), "Pending NoShow");
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Pending NoShow" } });
    const res = await request(app).post(`/api/booking/appointments/${appt!.id}/no-show`).set("Cookie", cookie);
    expect(res.status).toBe(409);
  });

  it("reminders SKIP a PENDING row", async () => {
    // A PENDING appointment inside the 24h reminder window.
    await book(futureAtHour(1, 16), "Pending Remind");
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Pending Remind" } });
    // Force it within 24h.
    await prisma.appointment.update({
      where: { id: appt!.id },
      data: { startsAt: new Date(Date.now() + 2 * 60 * 60 * 1000), endsAt: new Date(Date.now() + 2.5 * 60 * 60 * 1000) },
    });
    sent = [];
    await runAppointmentReminders(new Date());
    expect(sent.length).toBe(0); // PENDING is not reminded
  });

  it("a PENDING request with ADD-ONS holds the extended span (#68 x #69)", async () => {
    // Cross-feature: approval shop + a 15-min add-on. The request lands PENDING
    // with the EXTENDED endsAt + snapshot, and the hold blocks a second booking
    // inside the extension (10:30 fits the bare 30-min service but collides
    // with the 45-min extended hold).
    const addOn = await request(app)
      .post("/api/booking/addons")
      .set("Cookie", cookie)
      .send({ name: "Beard trim", durationMin: 15, price: 10 });
    expect(addOn.status).toBe(201);

    const at = futureAtHour(1, 10);
    const first = await book(at, "Extended Hold", { addOnIds: [addOn.body.id] });
    expect(first.status).toBe(201);
    expect(first.body.pending).toBe(true);
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Extended Hold" } });
    expect(appt?.status).toBe("PENDING");
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(45 * 60 * 1000);
    expect((appt!.addOns as unknown as { name: string }[])[0]!.name).toBe("Beard trim");

    // 10:30 collides with the extended [10:00, 10:45) hold -> 409.
    const inside = new Date(at.getTime() + 30 * 60 * 1000);
    const second = await book(inside, "Collider");
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("slot_taken");
  });

  it("promotion SKIPS a past PENDING row (no Visit, no punch)", async () => {
    await book(futureAtHour(1, 16), "Pending Promote");
    const appt = await prisma.appointment.findFirst({ where: { firstName: "Pending Promote" } });
    // Force it into the past so the promotion scan would pick up a BOOKED row.
    await prisma.appointment.update({
      where: { id: appt!.id },
      data: { startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await promoteFulfilledAppointments(new Date());
    const after = await prisma.appointment.findUnique({ where: { id: appt!.id }, select: { status: true, visitId: true } });
    expect(after?.status).toBe("PENDING"); // untouched
    expect(after?.visitId).toBeNull(); // no Visit created
  });
});
