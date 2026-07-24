import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { computeOpenSlots } from "../engines/slots.js";
import { createApp } from "../app.js";

/**
 * Targeted slots end-to-end: barber publishes special-priced one-off slots
 * (weekly-repeatable, allowed OUTSIDE normal hours), clients see them under the
 * parent service and book them at THE SLOT's price, capacity is exactly one
 * (proven with a real concurrent race, not a mock), and while unbooked they
 * block the normal grid through the ONE shared guard.
 */
const app = createApp();
const email = `tslot-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

/** Tomorrow at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function tomorrowAt(hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

function publicBooking(startsAt: Date, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      firstName: `C${randomToken(4)}`,
      email: `c-${randomToken(6)}@test.local`,
      ...extra,
    });
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Targeted Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Retwist", durationMin: 30, price: 80, staffIds: [staffId] });
  serviceId = service.body.id;

  // Hours: every day 09:00-17:00 (UTC == shop-local).
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  }));
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("barber CRUD + recurrence", () => {
  it("creates weekly repeats at the same wall time and lists them", async () => {
    const first = tomorrowAt(20); // 8pm - OUTSIDE the 9-17 hours, on purpose
    const created = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        label: "Late night retwist",
        startsAt: first.toISOString(),
        durationMin: 45,
        price: 60,
        repeatWeeks: 1,
      });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(2);

    const list = await request(app)
      .get("/api/booking/targeted-slots")
      .set("Cookie", cookie);
    expect(list.status).toBe(200);
    const slots = list.body.targetedSlots as { startsAt: string; booked: boolean; price: number }[];
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => !s.booked && s.price === 60)).toBe(true);
    // Week 2 = exactly 7 days later at the same wall time (UTC shop).
    expect(new Date(slots[1]!.startsAt).getTime()).toBe(
      new Date(slots[0]!.startsAt).getTime() + 7 * 24 * 60 * 60_000,
    );
  });

  it("shows them under the parent service on the public page", async () => {
    const pub = await request(app).get(`/api/book/${slug}`);
    expect(pub.status).toBe(200);
    const slots = pub.body.targetedSlots as { serviceId: string; price: number; label: string | null }[];
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots.every((s) => s.serviceId === serviceId)).toBe(true);
    expect(slots[0]!.price).toBe(60);
    expect(slots[0]!.label).toBe("Late night retwist");
  });
});

describe("blocking the normal grid (single source of truth)", () => {
  it("an unbooked targeted slot removes its time from the picker AND rejects a crafted POST", async () => {
    // In-hours slot at 10:00 tomorrow (a normal grid start time).
    const at = tomorrowAt(10);
    await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: at.toISOString(),
        durationMin: 30,
        price: 50,
      });

    // Picker: 10:00 is gone, 09:00 and 10:30 still offered.
    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: tomorrowAt(0),
      toDate: tomorrowAt(23, 59),
    });
    const starts = new Set(slots.map((s) => s.startsAt.toISOString()));
    expect(starts.has(at.toISOString())).toBe(false);
    expect(starts.has(tomorrowAt(9).toISOString())).toBe(true);
    expect(starts.has(tomorrowAt(10, 30).toISOString())).toBe(true);

    // A crafted normal POST at exactly 10:00 passes the advisory availability
    // check (grid shape) but the tx guard rejects it - the ONE guard is what
    // makes this safe, not the picker.
    const crafted = await publicBooking(at);
    expect(crafted.status).toBe(409);
    expect(crafted.body.error).toBe("slot_taken");
  });
});

describe("booking a targeted slot", () => {
  it("books at the slot's price outside normal hours, then disappears", async () => {
    const pub = await request(app).get(`/api/book/${slug}`);
    const slot = (pub.body.targetedSlots as { id: string; startsAt: string; label: string | null }[]).find(
      (s) => s.label === "Late night retwist",
    )!;

    const booked = await publicBooking(new Date(slot.startsAt), {
      targetedSlotId: slot.id,
    });
    expect(booked.status).toBe(201);

    const appt = await prisma.appointment.findUnique({
      where: { manageToken: booked.body.manageToken },
      select: { priceAtBooking: true, bookedVia: true, startsAt: true, endsAt: true },
    });
    expect(Number(appt!.priceAtBooking)).toBe(60); // the SLOT's price, not $80
    expect(appt!.bookedVia).toBe("targeted_slot");
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(45 * 60_000);

    // Claimed: gone from the public list; a repeat attempt is a clean 409.
    const pub2 = await request(app).get(`/api/book/${slug}`);
    expect(
      (pub2.body.targetedSlots as { id: string }[]).some((s) => s.id === slot.id),
    ).toBe(false);
    const again = await publicBooking(new Date(slot.startsAt), {
      targetedSlotId: slot.id,
    });
    expect(again.status).toBe(409);
  });

  it("REAL race: two simultaneous bookings of one slot - exactly one wins", async () => {
    const at = tomorrowAt(21);
    await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: at.toISOString(), durationMin: 30, price: 45 });
    const pub = await request(app).get(`/api/book/${slug}`);
    const slot = (pub.body.targetedSlots as { id: string; startsAt: string }[]).find(
      (s) => s.startsAt === at.toISOString(),
    )!;

    const [a, b] = await Promise.all([
      publicBooking(at, { targetedSlotId: slot.id }),
      publicBooking(at, { targetedSlotId: slot.id }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const appts = await prisma.appointment.count({
      where: { shopId, startsAt: at, status: "BOOKED" },
    });
    expect(appts).toBe(1);
    const row = await prisma.targetedSlot.findUnique({
      where: { id: slot.id },
      select: { bookedAppointmentId: true },
    });
    expect(row!.bookedAppointmentId).not.toBeNull();
  });

  it("REAL race: targeted booking vs a normal booking over the same time - one appointment survives", async () => {
    const at = tomorrowAt(11); // in-hours grid time
    await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: at.toISOString(), durationMin: 30, price: 55 });
    const pub = await request(app).get(`/api/book/${slug}`);
    const slot = (pub.body.targetedSlots as { id: string; startsAt: string }[]).find(
      (s) => s.startsAt === at.toISOString(),
    )!;

    const [targeted, normal] = await Promise.all([
      publicBooking(at, { targetedSlotId: slot.id }),
      publicBooking(at),
    ]);
    // The normal booking can never win this time: the slot blocks it while
    // unbooked, and the winning targeted appointment blocks it after.
    expect(targeted.status).toBe(201);
    expect(normal.status).toBe(409);
    const appts = await prisma.appointment.count({
      where: { shopId, startsAt: at, status: "BOOKED" },
    });
    expect(appts).toBe(1);
  });
});

describe("delete/deactivate", () => {
  it("deletes an unbooked slot (its grid time frees up), 409s a booked one", async () => {
    const at = tomorrowAt(14); // in-hours
    await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: at.toISOString(), durationMin: 30, price: 50 });
    const list = await request(app)
      .get("/api/booking/targeted-slots")
      .set("Cookie", cookie);
    const open = (list.body.targetedSlots as { id: string; startsAt: string; booked: boolean }[]).find(
      (s) => s.startsAt === at.toISOString(),
    )!;

    // While it exists, 14:00 is blocked for normal booking...
    const blocked = await publicBooking(at);
    expect(blocked.status).toBe(409);

    const del = await request(app)
      .delete(`/api/booking/targeted-slots/${open.id}`)
      .set("Cookie", cookie);
    expect(del.status).toBe(200);

    // ...and bookable normally again once deleted.
    const freed = await publicBooking(at);
    expect(freed.status).toBe(201);

    // A booked slot can't be deleted.
    const bookedSlot = await prisma.targetedSlot.findFirst({
      where: { shopId, bookedAppointmentId: { not: null } },
      select: { id: true },
    });
    const del2 = await request(app)
      .delete(`/api/booking/targeted-slots/${bookedSlot!.id}`)
      .set("Cookie", cookie);
    expect(del2.status).toBe(409);
  });
});

describe("request-before-booking interplay", () => {
  it("declining a PENDING targeted-slot request RELEASES the claim (booked cancel keeps it)", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ requireBookingApproval: true });
    const at = tomorrowAt(16); // in-hours
    await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: at.toISOString(), durationMin: 30, price: 40 });
    const pub = await request(app).get(`/api/book/${slug}`);
    const slot = (pub.body.targetedSlots as { id: string; startsAt: string }[]).find(
      (s) => s.startsAt === at.toISOString(),
    )!;

    // Booking lands as a PENDING request but the capacity-1 claim holds.
    const booked = await publicBooking(at, { targetedSlotId: slot.id });
    expect(booked.status).toBe(201);
    expect(booked.body.pending).toBe(true);
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: booked.body.manageToken },
      select: { id: true, status: true },
    });
    expect(appt!.status).toBe("PENDING");
    const claimed = await prisma.targetedSlot.findUnique({
      where: { id: slot.id },
      select: { bookedAppointmentId: true },
    });
    expect(claimed!.bookedAppointmentId).toBe(appt!.id);

    // Decline: the barber never accepted, so the special slot goes back on sale.
    const decline = await request(app)
      .post(`/api/booking/appointments/${appt!.id}/decline`)
      .set("Cookie", cookie);
    expect(decline.status).toBe(200);
    const released = await prisma.targetedSlot.findUnique({
      where: { id: slot.id },
      select: { bookedAppointmentId: true },
    });
    expect(released!.bookedAppointmentId).toBeNull();
    // ...and is publicly listed + bookable again.
    const pub2 = await request(app).get(`/api/book/${slug}`);
    expect(
      (pub2.body.targetedSlots as { id: string }[]).some((s) => s.id === slot.id),
    ).toBe(true);

    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ requireBookingApproval: false });
  });
});

describe("weekly series: until-turned-off + condensed grouping + bulk delete", () => {
  it("repeatForever creates a rule and materializes rows to the horizon", async () => {
    const first = tomorrowAt(21);
    const created = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: first.toISOString(),
        durationMin: 45,
        price: 90,
        label: "Standing special",
        repeatForever: true,
      });
    expect(created.status).toBe(201);
    expect(created.body.ruleId).toBeTruthy();
    // 91-day horizon, anchor ~1 day out, weekly cadence -> weeks 0..12 = 13 rows.
    expect(created.body.created).toBe(13);

    const rule = await prisma.targetedSlotRule.findUnique({
      where: { id: created.body.ruleId },
    });
    expect(rule!.indefinite).toBe(true);
    expect(rule!.weeksMaterialized).toBe(13);

    // Rows carry the ruleId and the list endpoint returns the rule for the
    // condensed series card.
    const list = await request(app)
      .get("/api/booking/targeted-slots")
      .set("Cookie", cookie);
    const mine = (list.body.targetedSlots as { ruleId: string | null }[]).filter(
      (t) => t.ruleId === created.body.ruleId,
    );
    expect(mine.length).toBe(13);
    const ruleRow = (list.body.rules as { id: string; indefinite: boolean }[]).find(
      (r) => r.id === created.body.ruleId,
    );
    expect(ruleRow?.indefinite).toBe(true);
  });

  it("roll-forward is idempotent and extend-only", async () => {
    const { materializeTargetedRule } = await import(
      "../engines/targetedSlotRules.js"
    );
    const rule = await prisma.targetedSlotRule.findFirst({
      where: { shopId, indefinite: true, active: true },
    });
    // Same horizon again: nothing new.
    const again = await materializeTargetedRule(
      rule!,
      "UTC",
      new Date(Date.now() + 91 * 24 * 60 * 60 * 1000),
    );
    expect(again).toBe(0);
    // A wider horizon extends by exactly the extra weeks.
    const wider = await materializeTargetedRule(
      { ...rule!, weeksMaterialized: rule!.weeksMaterialized },
      "UTC",
      new Date(Date.now() + (91 + 14) * 24 * 60 * 60 * 1000),
    );
    expect(wider).toBe(2);
  });

  it("finite repeats get a grouping rule; turning a series off deletes future unbooked rows only", async () => {
    const first = tomorrowAt(22);
    const created = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: first.toISOString(),
        durationMin: 30,
        price: 40,
        repeatWeeks: 3,
      });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(4);
    const ruleId = created.body.ruleId as string;
    expect(ruleId).toBeTruthy();

    // Book the first occurrence so it must SURVIVE the series delete.
    const slot = await prisma.targetedSlot.findFirst({
      where: { ruleId, startsAt: first },
    });
    const bookRes = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: first.toISOString(),
        firstName: "SeriesKeeper",
        email: `sk-${randomToken(6)}@test.local`,
        targetedSlotId: slot!.id,
      });
    expect(bookRes.status).toBe(201);

    const off = await request(app)
      .delete(`/api/booking/targeted-slots/rules/${ruleId}`)
      .set("Cookie", cookie);
    expect(off.status).toBe(200);
    expect(off.body.removed).toBe(3); // the 3 unbooked future rows

    const remaining = await prisma.targetedSlot.findMany({ where: { ruleId } });
    expect(remaining.length).toBe(1); // the booked one survives
    expect(remaining[0]!.bookedAppointmentId).not.toBeNull();
    const rule = await prisma.targetedSlotRule.findUnique({ where: { id: ruleId } });
    expect(rule!.active).toBe(false);
  });

  it("bulk delete removes only the unbooked selected ids", async () => {
    const a = tomorrowAt(23);
    const created = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: a.toISOString(),
        durationMin: 20,
        price: 25,
        repeatWeeks: 2,
      });
    expect(created.status).toBe(201);
    const rows = await prisma.targetedSlot.findMany({
      where: { ruleId: created.body.ruleId },
      orderBy: { startsAt: "asc" },
    });
    expect(rows.length).toBe(3);
    // Book the middle one; try to bulk-delete all three.
    const mid = rows[1]!;
    const bookRes = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: mid.startsAt.toISOString(),
        firstName: "BulkKeeper",
        email: `bk-${randomToken(6)}@test.local`,
        targetedSlotId: mid.id,
      });
    expect(bookRes.status).toBe(201);

    const bulk = await request(app)
      .post("/api/booking/targeted-slots/bulk-delete")
      .set("Cookie", cookie)
      .send({ ids: rows.map((r) => r.id) });
    expect(bulk.status).toBe(200);
    expect(bulk.body.removed).toBe(2);
    const left = await prisma.targetedSlot.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    expect(left.length).toBe(1);
    expect(left[0]!.id).toBe(mid.id);
  });

  it("rejects repeatWeeks together with repeatForever", async () => {
    const res = await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: tomorrowAt(12).toISOString(),
        durationMin: 30,
        price: 50,
        repeatWeeks: 4,
        repeatForever: true,
      });
    expect(res.status).toBe(400);
  });
});
