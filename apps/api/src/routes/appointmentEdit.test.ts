import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Editing an appointment must reuse the booking engine, not become a second
 * one. These tests are mostly about what an edit must REFUSE to do:
 * double-book, silently approve a pending request, move money, cross a tenant
 * boundary, or quietly corrupt a booking Acuity owns.
 */

const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let otherShopId: string;
let staffA: string;
let staffB: string;
let svcShort: string;
let svcLong: string;
let clientId: string;
let otherClientId: string;

/** Next Wednesday 15:00Z - comfortably inside the wide-open hours we seed. */
function slotAt(hourUtc: number, dayOffset = 7): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  // Lowercased: signup normalizes the address, so a mixed-case random
  // token would make the lookup below intermittently miss.
  const email = `edit-${randomToken(6).toLowerCase()}@test.local`;
  agent = request.agent(app);
  const signup = await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "E", smsAttested: true });
  expect(signup.status).toBeLessThan(400);

  const created = await agent
    .post("/api/shops")
    .send({ name: "Edit Shop", bookingUrl: "https://edit.test", smsAttested: true });
  expect(created.status).toBe(201);
  await agent
    .patch("/api/shops/me")
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0, bookingMaxDays: 400 });
  const me = await agent.get("/api/shops/me");
  shopId = me.body.id;

  const user = await prisma.user.findUnique({ where: { email } });
  const other = await prisma.shop.create({
    data: {
      ownerId: user!.id,
      name: "Other Shop",
      bookingUrl: "https://other.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
  });
  otherShopId = other.id;

  const a = await prisma.staff.create({ data: { shopId, name: "A" } });
  const b = await prisma.staff.create({ data: { shopId, name: "B" } });
  staffA = a.id;
  staffB = b.id;
  const s1 = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 30 },
  });
  const s2 = await prisma.service.create({
    data: { shopId, name: "Cut+Beard", durationMin: 60, price: 55 },
  });
  svcShort = s1.id;
  svcLong = s2.id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: svcShort, staffId: staffA },
      { shopId, serviceId: svcShort, staffId: staffB },
      { shopId, serviceId: svcLong, staffId: staffA },
      { shopId, serviceId: svcLong, staffId: staffB },
    ],
  });
  for (const staffId of [staffA, staffB]) {
    for (let wd = 0; wd < 7; wd++) {
      await prisma.availabilityRule.create({
        data: { shopId, staffId, weekday: wd, startMin: 0, endMin: 24 * 60 },
      });
    }
  }
  const c = await prisma.client.create({
    data: { shopId, acuityClientKey: randomToken(8), magicToken: randomToken(), firstName: "Real" },
  });
  clientId = c.id;
  const oc = await prisma.client.create({
    data: {
      shopId: otherShopId,
      acuityClientKey: randomToken(8),
      magicToken: randomToken(),
      firstName: "Foreign",
    },
  });
  otherClientId = oc.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
});

async function makeAppt(over: Partial<{
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: "BOOKED" | "PENDING";
  visitId: string | null;
}> = {}) {
  const startsAt = over.startsAt ?? slotAt(15);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: over.staffId ?? staffA,
      serviceId: over.serviceId ?? svcShort,
      clientId,
      firstName: "Sam",
      status: over.status ?? "BOOKED",
      startsAt,
      endsAt: over.endsAt ?? new Date(startsAt.getTime() + 30 * 60_000),
      visitId: over.visitId ?? null,
      manageToken: randomToken(),
    },
    select: { id: true, status: true, startsAt: true, endsAt: true },
  });
}

const patch = (id: string, body: unknown) =>
  agent.patch(`/api/booking/appointments/${id}`).send(body as object);

describe("time and duration", () => {
  it("moves the start time", async () => {
    const a = await makeAppt();
    const to = slotAt(17);
    const res = await patch(a.id, { startsAt: to.toISOString() });
    expect(res.status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.startsAt.toISOString()).toBe(to.toISOString());
    // Duration preserved across a pure time move.
    expect(row!.endsAt.getTime() - row!.startsAt.getTime()).toBe(30 * 60_000);
  });

  it("an explicit duration stretches the booking without moving its start", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { durationMin: 45 })).status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.startsAt.toISOString()).toBe(a.startsAt.toISOString());
    expect(row!.endsAt.getTime() - row!.startsAt.getTime()).toBe(45 * 60_000);
  });

  it("a service change adopts the new service's length", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { serviceId: svcLong })).status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.endsAt.getTime() - row!.startsAt.getTime()).toBe(60 * 60_000);
  });

  it("a NON-time edit preserves a hand-stretched duration", async () => {
    const start = slotAt(15);
    const a = await makeAppt({ startsAt: start, endsAt: new Date(start.getTime() + 45 * 60_000) });
    expect((await patch(a.id, { firstName: "Samuel" })).status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    // 45 minutes, NOT snapped back to the service's 30.
    expect(row!.endsAt.getTime() - row!.startsAt.getTime()).toBe(45 * 60_000);
  });

  it("changes the barber", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { staffId: staffB })).status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.staffId).toBe(staffB);
  });
});

describe("overlap is re-checked against everything but itself", () => {
  it("a no-op save does not conflict with its own row", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { startsAt: a.startsAt.toISOString() })).status).toBe(200);
  });

  it("EXACT overlap with another booking is refused", async () => {
    const other = slotAt(19);
    await makeAppt({ startsAt: other });
    const a = await makeAppt({ startsAt: slotAt(15) });
    const res = await patch(a.id, { startsAt: other.toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
  });

  it("PARTIAL overlap is refused, and the original is untouched", async () => {
    // A 60-minute booking at 19:00-20:00, then try to move ours onto 19:30 -
    // a REAL grid slot that lands halfway through it.
    const other = slotAt(19);
    await makeAppt({ startsAt: other, serviceId: svcLong, endsAt: new Date(other.getTime() + 60 * 60_000) });
    const a = await makeAppt({ startsAt: slotAt(15) });
    const clash = new Date(other.getTime() + 30 * 60_000); // 19:30-20:00
    const res = await patch(a.id, { startsAt: clash.toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.startsAt.toISOString()).toBe(a.startsAt.toISOString());
    expect(row!.endsAt.toISOString()).toBe(a.endsAt.toISOString());
  });

  it("an OFF-GRID time is refused by the availability gate, row untouched", async () => {
    const a = await makeAppt({ startsAt: slotAt(15) });
    const offGrid = new Date(slotAt(19).getTime() - 15 * 60_000); // 18:45
    const res = await patch(a.id, { startsAt: offGrid.toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.startsAt.toISOString()).toBe(a.startsAt.toISOString());
  });

  it("customTime lets the barber override the grid - but NOT an overlap", async () => {
    const a = await makeAppt({ startsAt: slotAt(15) });
    const offGrid = new Date(slotAt(19).getTime() - 15 * 60_000);
    // Override succeeds on an otherwise-free odd time.
    expect((await patch(a.id, { startsAt: offGrid.toISOString(), customTime: true })).status).toBe(200);
    // But a second booking cannot be overridden onto the same chair-time.
    const b = await makeAppt({ startsAt: slotAt(13) });
    const res = await patch(b.id, { startsAt: offGrid.toISOString(), customTime: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
  });

  it("stretching a duration INTO the next booking is refused", async () => {
    const start = slotAt(15);
    await makeAppt({ startsAt: new Date(start.getTime() + 30 * 60_000) }); // 15:30
    const a = await makeAppt({ startsAt: start }); // 15:00-15:30
    expect((await patch(a.id, { durationMin: 60 })).status).toBe(409);
  });

  it("moving to the OTHER barber's free time succeeds even when this one is busy", async () => {
    const t = slotAt(19);
    await makeAppt({ startsAt: t, staffId: staffA });
    const a = await makeAppt({ startsAt: slotAt(15), staffId: staffB });
    // staffB is free at 19:00 even though staffA is not.
    expect((await patch(a.id, { startsAt: t.toISOString() })).status).toBe(200);
  });
});

describe("status is never silently changed", () => {
  it("editing a PENDING request leaves it PENDING", async () => {
    const a = await makeAppt({ status: "PENDING" });
    const res = await patch(a.id, { startsAt: slotAt(17).toISOString(), notes: "moved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.status).toBe("PENDING");
  });

  it("a CANCELED appointment cannot be edited", async () => {
    const a = await makeAppt();
    await prisma.appointment.update({ where: { id: a.id }, data: { status: "CANCELED" } });
    const res = await patch(a.id, { notes: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_editable");
  });
});

describe("Acuity-owned bookings are read-only", () => {
  it("a Visit-linked appointment is refused", async () => {
    const visit = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: randomToken(8),
        status: "SCHEDULED",
        scheduledAt: slotAt(15),
        endAt: slotAt(16),
      },
      select: { id: true },
    });
    const a = await makeAppt({ visitId: visit.id });
    const res = await patch(a.id, { notes: "nope" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("synced_appointment_readonly");
  });
});

describe("tenant isolation", () => {
  it("a client from ANOTHER shop cannot be attached", async () => {
    const a = await makeAppt();
    const res = await patch(a.id, { clientId: otherClientId });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("client_not_found");
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.clientId).toBe(clientId);
  });

  it("an appointment in another shop is not found", async () => {
    const foreign = await prisma.appointment.create({
      data: {
        shopId: otherShopId,
        staffId: (await prisma.staff.create({ data: { shopId: otherShopId, name: "X" } })).id,
        serviceId: (
          await prisma.service.create({
            data: { shopId: otherShopId, name: "S", durationMin: 30, price: 10 },
          })
        ).id,
        firstName: "Nope",
        status: "BOOKED",
        startsAt: slotAt(15),
        endsAt: slotAt(16),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    expect((await patch(foreign.id, { notes: "x" })).status).toBe(404);
  });

  it("an unknown staff id is refused", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { staffId: "stf_nope" })).status).toBe(404);
  });
});

describe("fields and side effects", () => {
  it("saves notes and price without touching the time", async () => {
    const a = await makeAppt();
    const res = await patch(a.id, { notes: "comping the beard", price: 42.5 });
    expect(res.status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.notes).toBe("comping the beard");
    expect(Number(row!.priceAtBooking)).toBe(42.5);
    expect(row!.startsAt.toISOString()).toBe(a.startsAt.toISOString());
  });

  it("a NON-time edit does NOT reset the confirmation stamp (no re-text)", async () => {
    const a = await makeAppt();
    const stamp = new Date();
    await prisma.appointment.update({
      where: { id: a.id },
      data: { confirmationSentAt: stamp },
    });
    await patch(a.id, { notes: "typo fix" });
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.confirmationSentAt).not.toBeNull();
  });

  it("a TIME move DOES reset send-state so the new time is confirmed", async () => {
    const a = await makeAppt();
    await prisma.appointment.update({
      where: { id: a.id },
      data: { confirmationSentAt: new Date(), checkInStatus: "en_route" },
    });
    await patch(a.id, { startsAt: slotAt(17).toISOString() });
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.confirmationSentAt).toBeNull();
    expect(row!.checkInStatus).toBeNull();
  });

  it("rejects unknown fields rather than ignoring them", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { status: "BOOKED" })).status).toBe(400);
  });

  it("reports the Acuity mirror outcome so the UI can be honest", async () => {
    const a = await makeAppt();
    const res = await patch(a.id, { startsAt: slotAt(17).toISOString() });
    expect(res.status).toBe(200);
    // Shop is OFF, so nothing was mirrored - and the response says so.
    expect(res.body.mirror).toBe("skipped");
  });
});

describe("contact", () => {
  beforeEach(async () => {
    await prisma.client.update({
      where: { id: clientId },
      data: {
        phone: null,
        email: null,
        smsConsentAt: null,
        smsConsentSource: null,
        optedOut: false,
      },
    });
  });

  it("normalizes a typed phone to E.164 on BOTH the booking and the client", async () => {
    const a = await makeAppt();
    const res = await patch(a.id, { phone: "(201) 555-0134", email: "Sam@Example.TEST" });
    expect(res.status).toBe(200);

    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.phone).toBe("+12015550134");
    expect(row!.email).toBe("sam@example.test");

    // The CLIENT row is the SMS/email channel of record - a correction that
    // stopped at the appointment would leave reminders on the old number.
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client!.phone).toBe("+12015550134");
    expect(client!.email).toBe("sam@example.test");
  });

  it("🔴 editing a phone number creates NO SMS consent", async () => {
    const a = await makeAppt();
    expect((await patch(a.id, { phone: "+12015550134" })).status).toBe(200);
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client!.smsConsentAt).toBeNull();
    expect(client!.smsConsentSource).toBeNull();
    // And it does not quietly un-opt-out anyone either.
    expect(client!.optedOut).toBe(false);
  });

  it("🔴 a contact edit never DISTURBS consent that is already on file", async () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    await prisma.client.update({
      where: { id: clientId },
      data: { smsConsentAt: at, smsConsentSource: "barber_attest", optedOut: true },
    });
    const a = await makeAppt();
    expect((await patch(a.id, { phone: "+12015550199" })).status).toBe(200);
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client!.smsConsentAt!.toISOString()).toBe(at.toISOString());
    expect(client!.smsConsentSource).toBe("barber_attest");
    // A STOP is only ever undone by the client. Correcting a typo is not that.
    expect(client!.optedOut).toBe(true);
  });

  it("a contact edit never repoints acuityClientKey (the sync anchor)", async () => {
    const before = await prisma.client.findUnique({ where: { id: clientId } });
    const a = await makeAppt();
    expect((await patch(a.id, { phone: "+12015550177" })).status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: clientId } });
    expect(after!.acuityClientKey).toBe(before!.acuityClientKey);
  });

  it("an unusable phone is REFUSED, not silently stored as nothing", async () => {
    const a = await makeAppt();
    const res = await patch(a.id, { phone: "call me!!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phone");
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.phone).toBeNull();
  });

  it("an empty string clears the number on both records", async () => {
    await prisma.client.update({
      where: { id: clientId },
      data: { phone: "+12015550134" },
    });
    const a = await makeAppt();
    expect((await patch(a.id, { phone: "" })).status).toBe(200);
    expect((await prisma.appointment.findUnique({ where: { id: a.id } }))!.phone).toBeNull();
    expect((await prisma.client.findUnique({ where: { id: clientId } }))!.phone).toBeNull();
  });

  it("a clientless walk-in still saves its own contact", async () => {
    const a = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staffA,
        serviceId: svcShort,
        clientId: null,
        firstName: "Walkin",
        status: "BOOKED",
        startsAt: slotAt(15),
        endsAt: new Date(slotAt(15).getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    expect((await patch(a.id, { phone: "+12015550188" })).status).toBe(200);
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.phone).toBe("+12015550188");
  });

  it("contact lands on the client the booking is attached to AFTER a swap", async () => {
    const other = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: randomToken(8),
        magicToken: randomToken(),
        firstName: "Swapped",
      },
      select: { id: true },
    });
    const a = await makeAppt();
    expect(
      (await patch(a.id, { clientId: other.id, phone: "+12015550166" })).status,
    ).toBe(200);
    expect((await prisma.client.findUnique({ where: { id: other.id } }))!.phone).toBe(
      "+12015550166",
    );
    // The client who was detached keeps the number they had (none).
    expect((await prisma.client.findUnique({ where: { id: clientId } }))!.phone).toBeNull();
  });
});

describe("money never moves as a side effect", () => {
  async function payFor(appointmentId: string, status: string, amount = 3000) {
    return prisma.payment.create({
      data: {
        shopId,
        appointmentId,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount,
        status,
      },
    });
  }

  it("🔴 the price of an ALREADY-PAID booking cannot be changed", async () => {
    const a = await makeAppt();
    await payFor(a.id, "succeeded", 3000);
    const res = await patch(a.id, { price: 45 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("price_change_on_paid");
    // And the row is untouched - no partial write behind the refusal.
    const row = await prisma.appointment.findUnique({ where: { id: a.id } });
    expect(row!.priceAtBooking).toBeNull();
  });

  it("a paid booking can still have everything ELSE edited", async () => {
    const a = await makeAppt();
    await payFor(a.id, "succeeded", 3000);
    const res = await patch(a.id, { notes: "moved from Saturday", phone: "+12015550134" });
    expect(res.status).toBe(200);
    expect((await prisma.appointment.findUnique({ where: { id: a.id } }))!.notes).toBe(
      "moved from Saturday",
    );
  });

  it("re-sending the SAME price on a paid booking is allowed (a no-op is not a change)", async () => {
    const a = await makeAppt();
    await prisma.appointment.update({ where: { id: a.id }, data: { priceAtBooking: 30 } });
    await payFor(a.id, "succeeded", 3000);
    expect((await patch(a.id, { price: 30, notes: "x" })).status).toBe(200);
  });

  it("an UNPAID intent does not lock the price", async () => {
    const a = await makeAppt();
    await payFor(a.id, "requires_payment_method", 3000);
    expect((await patch(a.id, { price: 45 })).status).toBe(200);
  });
});
