import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * BLOCKED TIME WINS — the tester's vacation-week bug, pinned on every surface.
 *
 * A barber blocked his days off, and a booking request still came through: his
 * weekly special (targeted slot) kept publishing chips straight through the
 * blocked days. Targeted slots deliberately bypass HOURS and the lead/max
 * window — that's the feature — but a block is "I'm not there", and it beats
 * the barber's own standing special on every public surface:
 *
 *   - the flat payload (GET /:slug targetedSlots)
 *   - the /day chips
 *   - the /open-days date strip
 *   - the booking POST itself (a crafted/stale request must 409)
 *
 * Also pinned: unblocking restores the special untouched (the filter is
 * read-time, nothing is deactivated), a partial-day block that misses the
 * special leaves it alone, and one barber's block never hides another's slots.
 */
const app = createApp();
const email = `tsb-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let staffBId: string;
let serviceId: string;

/** N days out at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function daysOutAt(days: number, hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

/** The shop-local (UTC here) YYYY-MM-DD key for a date. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight bounding [start of day, start of next day] for a date. */
function dayBounds(d: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

function bookSlot(startsAt: Date, targetedSlotId: string) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      targetedSlotId,
      firstName: `C${randomToken(4)}`,
      email: `c-${randomToken(6)}@test.local`,
    });
}

/** Publish a targeted slot directly (the API's own routes are exercised in
 *  targetedSlots.test.ts; here they'd just be noise around the block logic). */
async function publishSlot(at: Date, forStaff = staffId): Promise<string> {
  const row = await prisma.targetedSlot.create({
    data: {
      shopId,
      staffId: forStaff,
      serviceId,
      startsAt: at,
      durationMin: 30,
      price: 65,
      label: "Late night",
      active: true,
    },
  });
  return row.id;
}

async function blockSpan(start: Date, end: Date, forStaff = staffId): Promise<string> {
  const res = await request(app)
    .post(`/api/booking/staff/${forStaff}/exceptions`)
    .set("Cookie", cookie)
    .send({ startsAt: start.toISOString(), endsAt: end.toISOString(), isBlock: true });
  expect(res.status).toBe(201);
  const row = await prisma.availabilityException.findFirst({
    where: { shopId, staffId: forStaff, startsAt: start, endsAt: end },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  expect(row).not.toBeNull();
  return row!.id;
}

async function flatTargetedIds(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}`);
  expect(res.status).toBe(200);
  return (res.body.targetedSlots as { id: string }[]).map((t) => t.id);
}

async function dayTargetedIds(date: string): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}/day`).query({ date });
  expect(res.status).toBe(200);
  const buckets = [
    ...(res.body.bundles as { services: unknown[] }[]).flatMap(
      (b) => b.services as { slots: { targeted?: { id: string } }[] }[],
    ),
    ...(res.body.ungrouped as { slots: { targeted?: { id: string } }[] }[]),
  ];
  return buckets
    .flatMap((s) => s.slots)
    .map((s) => s.targeted?.id)
    .filter((id): id is string => Boolean(id));
}

async function openDays(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}/open-days`);
  expect(res.status).toBe(200);
  return res.body.openDays as string[];
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Blocked Cuts", bookingUrl: "https://book.test", smsAttested: true });
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
  const staffB = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Riley" });
  staffBId = staffB.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId, staffBId] });
  serviceId = service.body.id;

  // Hours: every day 09:00-17:00 for both barbers (UTC == shop-local).
  for (const id of [staffId, staffBId]) {
    const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    }));
    const res = await request(app)
      .put(`/api/booking/staff/${id}/availability`)
      .set("Cookie", cookie)
      .send({ rules });
    expect(res.status).toBe(200);
  }
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("a one-off block beats a published special (the vacation-day bug)", () => {
  // The tester's shape: a 7pm special (outside the 9-17 hours - the whole
  // point of specials) on a day the barber then blocks off entirely.
  const specialAt = daysOutAt(3, 19);
  const { start: dayStart, end: dayEnd } = dayBounds(specialAt);
  let slotId: string;
  let blockId: string;

  it("baseline: the special shows on all three read surfaces", async () => {
    slotId = await publishSlot(specialAt);
    expect(await flatTargetedIds()).toContain(slotId);
    expect(await dayTargetedIds(dayKey(specialAt))).toContain(slotId);
    expect(await openDays()).toContain(dayKey(specialAt));
  });

  it("blocking the barber's whole day hides his special", async () => {
    blockId = await blockSpan(dayStart, dayEnd);
    expect(await flatTargetedIds()).not.toContain(slotId);
    expect(await dayTargetedIds(dayKey(specialAt))).not.toContain(slotId);
    // The day itself stays in the date strip: RILEY still works 9-17 that day.
    // A block is per-barber, and one barber's vacation must not grey a day the
    // other genuinely has open.
    expect(await openDays()).toContain(dayKey(specialAt));
  });

  it("once EVERY barber's day is blocked, the day leaves the strip entirely", async () => {
    await blockSpan(dayStart, dayEnd, staffBId);
    expect(await openDays()).not.toContain(dayKey(specialAt));
  });

  it("booking it anyway (stale chip / crafted POST) is refused", async () => {
    const res = await bookSlot(specialAt, slotId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    // Nothing was written - not an appointment, not a claim on the slot row.
    const row = await prisma.targetedSlot.findUnique({ where: { id: slotId } });
    expect(row?.bookedAppointmentId).toBeNull();
  });

  it("the plain grid on that day is equally dead (the direct repro)", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: daysOutAt(3, 10).toISOString(),
        firstName: "X",
        email: `x-${randomToken(6)}@test.local`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
  });

  it("unblocking restores the special untouched - filter, not deletion", async () => {
    const del = await request(app)
      .delete(`/api/booking/exceptions/${blockId}`)
      .set("Cookie", cookie);
    expect(del.status).toBe(200);
    expect(await flatTargetedIds()).toContain(slotId);
    // Sam's grid is back too, so the day returns to the strip (Riley's own
    // block from the previous test only ever covered Riley).
    expect(await openDays()).toContain(dayKey(specialAt));
    // And it books - fully alive again, at the slot's own snapshotted price.
    const res = await bookSlot(specialAt, slotId);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    const claimed = await prisma.targetedSlot.findUnique({
      where: { id: slotId },
      select: { bookedAppointmentId: true },
    });
    expect(claimed?.bookedAppointmentId).not.toBeNull();
    const appt = await prisma.appointment.findUnique({
      where: { id: claimed!.bookedAppointmentId! },
      select: { priceAtBooking: true },
    });
    expect(Number(appt?.priceAtBooking)).toBe(65);
  });
});

describe("precision: blocks hide exactly what they cover", () => {
  const specialAt = daysOutAt(4, 19);
  let slotId: string;

  it("a partial block that misses the special leaves it alone", async () => {
    slotId = await publishSlot(specialAt);
    // Block 12:00-14:00 that day; the 19:00 special is untouched.
    await blockSpan(daysOutAt(4, 12), daysOutAt(4, 14));
    expect(await flatTargetedIds()).toContain(slotId);
    expect(await dayTargetedIds(dayKey(specialAt))).toContain(slotId);
  });

  it("a block GRAZING the special's span kills it (overlap, not containment)", async () => {
    // 19:15-19:20 sits inside the special's 19:00-19:30 span.
    await blockSpan(daysOutAt(4, 19, 15), daysOutAt(4, 19, 20));
    expect(await flatTargetedIds()).not.toContain(slotId);
    const res = await bookSlot(specialAt, slotId);
    expect(res.status).toBe(409);
  });

  it("one barber's block never hides another barber's special", async () => {
    const bAt = daysOutAt(5, 19);
    const bSlot = await publishSlot(bAt, staffBId);
    // Block staff A's entire day 5; Riley's special is not Sam's problem.
    const { start, end } = dayBounds(bAt);
    await blockSpan(start, end, staffId);
    expect(await flatTargetedIds()).toContain(bSlot);
    expect(await dayTargetedIds(dayKey(bAt))).toContain(bSlot);
  });
});

describe("recurring and external blocks carry the same authority", () => {
  it("a standing weekly break hides a special published inside it", async () => {
    const at = daysOutAt(6, 19);
    const slotId = await publishSlot(at);
    await prisma.recurringBlock.create({
      data: {
        shopId,
        staffId,
        weekday: at.getUTCDay(),
        startMin: 18 * 60,
        endMin: 20 * 60,
        reason: "standing break",
      },
    });
    expect(await flatTargetedIds()).not.toContain(slotId);
    const res = await bookSlot(at, slotId);
    expect(res.status).toBe(409);
    await prisma.recurringBlock.deleteMany({ where: { shopId, staffId } });
  });

  it("Acuity-synced blocked time hides specials for EVERY barber", async () => {
    const at = daysOutAt(7, 19);
    const mine = await publishSlot(at, staffId);
    const theirs = await publishSlot(new Date(at.getTime() + 10 * 60_000), staffBId);
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:blk-${randomToken(6)}`,
        startsAt: daysOutAt(7, 18, 30),
        endsAt: daysOutAt(7, 20),
      },
    });
    const flat = await flatTargetedIds();
    expect(flat).not.toContain(mine);
    expect(flat).not.toContain(theirs);
    expect((await bookSlot(at, mine)).status).toBe(409);
    await prisma.externalBlock.deleteMany({ where: { shopId } });
  });
});
