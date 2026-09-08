import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * POST /api/booking/staff/:id/exceptions - blocking whole days, future days,
 * and days that already hold bookings.
 *
 * What has to be true, end to end, against the real slot engine:
 *  - a day range becomes one all-day row PER DAY, every midnight resolved in
 *    the SHOP's zone (New York here, so a UTC midnight would be wrong by hours);
 *  - every day in the range is closed to customers and the days on either
 *    side stay open - a block that leaks a day or eats a neighbour is worse
 *    than no block;
 *  - a future timed block closes exactly its hours: the slot that starts the
 *    minute it ends still books;
 *  - the calendar lists the block on EACH day it covers, so it is there after
 *    a reload;
 *  - a block over an existing booking is refused with the booking named, and
 *    confirming it writes the block while the booking stays exactly as it was.
 */
const app = createApp();
const password = "supersecret123";
const NY = "America/New_York";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

/** The shop-local day key `daysAhead` days from now. */
function dayKeyAhead(daysAhead: number): string {
  const p = zonedDateParts(new Date(Date.now() + daysAhead * DAY_MS), NY);
  const mm = String(p.month0 + 1).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** The instant at `hour`:00 New York time on a day key. */
function nyAt(dayKey: string, hour: number): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return zonedWallTimeToUtc(y!, m! - 1, d!, hour * 60, NY);
}

async function makeShop(label: string) {
  const email = `blockdays-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Block Days", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://b.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;

  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: NY, bookingLeadHours: 0, bookingMaxDays: 60 },
  });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId: staff.id },
  });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return {
    cookie,
    shopId,
    slug: me.body.slug as string,
    staffId: staff.id,
    serviceId: service.id,
  };
}

type Shop = Awaited<ReturnType<typeof makeShop>>;

function postBlock(s: Shop, body: Record<string, unknown>, staffId = s.staffId) {
  return request(app)
    .post(`/api/booking/staff/${staffId}/exceptions`)
    .set("Cookie", s.cookie)
    .send(body);
}

let seq = 0;
function book(s: Shop, when: Date, name = "Pat") {
  seq += 1;
  return request(app)
    .post(`/api/book/${s.slug}`)
    .send({
      staffId: s.staffId,
      serviceId: s.serviceId,
      startsAt: when.toISOString(),
      firstName: name,
      lastName: "Rivera",
      phone: `(302) 555-${String(1000 + seq).padStart(4, "0")}`,
      email: `blockdays${seq}@example.com`,
    });
}

async function slotsOn(s: Shop, dayKey: string): Promise<string[]> {
  const res = await request(app)
    .get(`/api/book/${s.slug}/slots`)
    .query({
      staffId: s.staffId,
      serviceId: s.serviceId,
      from: nyAt(dayKey, 0).toISOString(),
      to: nyAt(dayKeyAheadFrom(dayKey, 1), 0).toISOString(),
    });
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((x) => x.startsAt);
}

/** `dayKey` plus `n` days, as a key (UTC-noon arithmetic on the key alone). */
function dayKeyAheadFrom(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d! + n, 12));
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${at.getUTCFullYear()}-${mm}-${dd}`;
}

async function blockRows(s: Shop) {
  return prisma.availabilityException.findMany({
    where: { shopId: s.shopId, staffId: s.staffId, isBlock: true },
    orderBy: { startsAt: "asc" },
    select: { id: true, startsAt: true, endsAt: true, reason: true },
  });
}

let S: Shop;

beforeAll(async () => {
  S = await makeShop("Block Days Cuts");
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

describe("blocking whole days", () => {
  it("writes one all-day row per day, each midnight resolved in the shop's zone", async () => {
    const from = dayKeyAhead(3);
    const to = dayKeyAhead(5);
    const res = await postBlock(S, { fromDate: from, toDate: to, allDay: true, reason: "Vacation" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, created: 3, overlappingAppointments: 0 });

    const rows = await blockRows(S);
    expect(rows).toHaveLength(3);
    const keys = [from, dayKeyAheadFrom(from, 1), to];
    rows.forEach((r, i) => {
      // New York midnight, not UTC midnight - the two differ by four or five hours.
      expect(r.startsAt.toISOString()).toBe(nyAt(keys[i]!, 0).toISOString());
      expect(r.endsAt.toISOString()).toBe(nyAt(dayKeyAheadFrom(keys[i]!, 1), 0).toISOString());
      expect(r.startsAt.getUTCHours()).not.toBe(0);
      expect(r.reason).toBe("Vacation");
    });
    // Contiguous: each day ends exactly where the next begins.
    expect(rows[1]!.startsAt.getTime()).toBe(rows[0]!.endsAt.getTime());
    expect(rows[2]!.startsAt.getTime()).toBe(rows[1]!.endsAt.getTime());
  });

  it("closes every day in the range to customers and leaves both neighbours open", async () => {
    // Rows from the test above: days +3..+5.
    expect(await slotsOn(S, dayKeyAhead(2))).not.toHaveLength(0);
    expect(await slotsOn(S, dayKeyAhead(3))).toHaveLength(0);
    expect(await slotsOn(S, dayKeyAhead(4))).toHaveLength(0);
    expect(await slotsOn(S, dayKeyAhead(5))).toHaveLength(0);
    expect(await slotsOn(S, dayKeyAhead(6))).not.toHaveLength(0);

    // The write path agrees with the grid: inside is refused, the day after books.
    const inside = await book(S, nyAt(dayKeyAhead(4), 10));
    expect(inside.status).toBe(400);
    expect(inside.body.error).toBe("invalid_slot");
    const lastMinuteOfRange = await book(S, nyAt(dayKeyAhead(5), 16));
    expect(lastMinuteOfRange.status).toBe(400);
    const after = await book(S, nyAt(dayKeyAhead(6), 10));
    expect(after.status).toBe(201);
  });

  it("lists the block on each day it covers, so the calendar shows it after a reload", async () => {
    const from = nyAt(dayKeyAhead(2), 0).toISOString();
    const to = nyAt(dayKeyAhead(7), 0).toISOString();
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", S.cookie);
    expect(agenda.status).toBe(200);
    const blocks = (agenda.body.agenda as { source: string; start: string; end: string; clientName: string }[])
      .filter((r) => r.source === "block")
      .sort((a, b) => a.start.localeCompare(b.start));
    expect(blocks.map((b) => b.start)).toEqual(
      [3, 4, 5].map((n) => nyAt(dayKeyAhead(n), 0).toISOString()),
    );
    expect(blocks.every((b) => b.clientName === "Vacation")).toBe(true);
  });

  it("refuses an impossible date, an inverted range, days that have passed, and a range over a year", async () => {
    const bad = async (body: Record<string, unknown>, field: string) => {
      const res = await postBlock(S, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_input");
      expect(JSON.stringify(res.body.issues)).toContain(field);
    };
    const before = (await blockRows(S)).length;
    await bad({ fromDate: "2026-02-30", toDate: dayKeyAhead(9), allDay: true }, "fromDate");
    await bad({ fromDate: dayKeyAhead(9), toDate: dayKeyAhead(8), allDay: true }, "toDate");
    await bad({ fromDate: dayKeyAhead(-5), toDate: dayKeyAhead(-2), allDay: true }, "toDate");
    await bad({ fromDate: dayKeyAhead(9), toDate: dayKeyAhead(9 + 366), allDay: true }, "toDate");
    // The day form is all-day by definition; the flag is part of the shape.
    const noFlag = await postBlock(S, { fromDate: dayKeyAhead(9), toDate: dayKeyAhead(9) });
    expect(noFlag.status).toBe(400);
    // The instant form still refuses an end at or before its start.
    const inverted = await postBlock(S, {
      startsAt: nyAt(dayKeyAhead(9), 12).toISOString(),
      endsAt: nyAt(dayKeyAhead(9), 12).toISOString(),
      isBlock: true,
    });
    expect(inverted.status).toBe(400);
    expect((await blockRows(S)).length).toBe(before);
  });

  it("cannot block another shop's chair", async () => {
    const other = await makeShop("Other Cuts");
    const res = await postBlock(
      S,
      { fromDate: dayKeyAhead(9), toDate: dayKeyAhead(9), allDay: true },
      other.staffId,
    );
    expect(res.status).toBe(404);
    expect(await blockRows(other)).toHaveLength(0);
  });
});

describe("a future timed block", () => {
  it("closes exactly its hours: the slot that starts as it ends still books", async () => {
    const day = dayKeyAhead(12);
    const res = await postBlock(S, {
      startsAt: nyAt(day, 12).toISOString(),
      endsAt: nyAt(day, 14).toISOString(),
      isBlock: true,
      reason: "Lunch + bank",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, created: 1 });

    const starts = new Set(await slotsOn(S, day));
    expect(starts.has(nyAt(day, 12).toISOString())).toBe(false);
    expect(starts.has(nyAt(day, 13).toISOString())).toBe(false);
    expect(starts.has(nyAt(day, 11).toISOString())).toBe(true);
    expect(starts.has(nyAt(day, 14).toISOString())).toBe(true);

    const inside = await book(S, nyAt(day, 13));
    expect(inside.status).toBe(400);
    expect(inside.body.error).toBe("invalid_slot");
    const adjacent = await book(S, nyAt(day, 14));
    expect(adjacent.status).toBe(201);
  });
});

describe("blocking over an existing booking", () => {
  it("is refused with the booking named, then written on confirmation with the booking untouched", async () => {
    const day = dayKeyAhead(20);
    const booked = await book(S, nyAt(day, 10), "Marcus");
    expect(booked.status).toBe(201);
    // The public reply carries the manage token, not the row id.
    const manageToken = booked.body.manageToken as string;
    const before = (await blockRows(S)).length;

    const refused = await postBlock(S, {
      fromDate: day,
      toDate: dayKeyAheadFrom(day, 1),
      allDay: true,
      reason: "Away",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("appointments_overlap");
    expect(refused.body.confirmable).toBe(true);
    expect(refused.body.count).toBe(1);
    expect(refused.body.reason).toBe("1 appointment is already booked during this time.");
    expect(refused.body.conflicts).toHaveLength(1);
    expect(refused.body.conflicts[0]).toContain("Marcus Rivera · Fade");
    expect(refused.body.conflicts[0]).toContain("10:00 AM–10:30 AM");
    const confirmation = refused.body.confirmation as string;
    expect(confirmation).toMatch(/^[0-9a-f]{32}$/);
    // Nothing was written by the refusal.
    expect((await blockRows(S)).length).toBe(before);

    // A made-up answer is not an answer.
    const forged = await postBlock(S, {
      fromDate: day,
      toDate: dayKeyAheadFrom(day, 1),
      allDay: true,
      confirmation: "0".repeat(32),
    });
    expect(forged.status).toBe(409);
    expect((await blockRows(S)).length).toBe(before);

    const confirmed = await postBlock(S, {
      fromDate: day,
      toDate: dayKeyAheadFrom(day, 1),
      allDay: true,
      reason: "Away",
      confirmation,
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({ ok: true, created: 2, overlappingAppointments: 1 });
    expect((await blockRows(S)).length).toBe(before + 2);

    // THE POINT: the booking is exactly as it was. Never cancelled, never moved.
    const appt = await prisma.appointment.findUnique({
      where: { manageToken },
      select: { status: true, startsAt: true, endsAt: true, staffId: true },
    });
    expect(appt).toMatchObject({
      status: "BOOKED",
      startsAt: nyAt(day, 10),
      endsAt: new Date(nyAt(day, 10).getTime() + 30 * 60_000),
      staffId: S.staffId,
    });
    // And nobody else can book around it now.
    expect(await slotsOn(S, dayKeyAheadFrom(day, 1))).toHaveLength(0);
  });

  it("a confirmation for a conflict that has since changed is refused with the new conflict", async () => {
    const day = dayKeyAhead(25);
    expect((await book(S, nyAt(day, 10), "First")).status).toBe(201);

    const first = await postBlock(S, { fromDate: day, toDate: day, allDay: true });
    expect(first.status).toBe(409);
    const stale = first.body.confirmation as string;

    // The barber leaves the sheet open; a customer books the 11:00 meanwhile.
    expect((await book(S, nyAt(day, 11), "Second")).status).toBe(201);

    const replay = await postBlock(S, { fromDate: day, toDate: day, allDay: true, confirmation: stale });
    expect(replay.status).toBe(409);
    expect(replay.body.count).toBe(2);
    expect(replay.body.confirmation).not.toBe(stale);
    expect(replay.body.conflicts.join("\n")).toContain("Second Rivera");

    const fresh = await postBlock(S, {
      fromDate: day,
      toDate: day,
      allDay: true,
      confirmation: replay.body.confirmation,
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.overlappingAppointments).toBe(2);
    expect(await prisma.appointment.count({ where: { shopId: S.shopId, status: "BOOKED" } })).toBeGreaterThanOrEqual(4);
  });

  it("the timed form is held to the same rule", async () => {
    const day = dayKeyAhead(30);
    expect((await book(S, nyAt(day, 15), "Timed")).status).toBe(201);
    const res = await postBlock(S, {
      startsAt: nyAt(day, 14).toISOString(),
      endsAt: nyAt(day, 16).toISOString(),
      isBlock: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("appointments_overlap");
    // A block that merely touches the booking's edges is not over it.
    const beside = await postBlock(S, {
      startsAt: nyAt(day, 13).toISOString(),
      endsAt: nyAt(day, 15).toISOString(),
      isBlock: true,
    });
    expect(beside.status).toBe(201);
  });
});

describe("the same hours on every day of a range", () => {
  it("writes one row per day at those shop-local hours, closes exactly them, and keeps the rest of each day open", async () => {
    const from = dayKeyAhead(40);
    const to = dayKeyAheadFrom(from, 2);
    // 9:00-12:00 New York, each of the three days.
    const res = await postBlock(S, {
      fromDate: from,
      toDate: to,
      fromMin: 9 * 60,
      toMin: 12 * 60,
      reason: "Mornings off",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, created: 3, overlappingAppointments: 0 });

    const rows = (await blockRows(S)).filter((r) => r.reason === "Mornings off");
    expect(rows).toHaveLength(3);
    [from, dayKeyAheadFrom(from, 1), to].forEach((key, i) => {
      expect(rows[i]!.startsAt.toISOString()).toBe(nyAt(key, 9).toISOString());
      expect(rows[i]!.endsAt.toISOString()).toBe(nyAt(key, 12).toISOString());
    });

    for (const key of [from, dayKeyAheadFrom(from, 1), to]) {
      const starts = new Set(await slotsOn(S, key));
      expect(starts.has(nyAt(key, 9).toISOString())).toBe(false);
      expect(starts.has(nyAt(key, 11).toISOString())).toBe(false);
      // The afternoon is untouched, and so is the slot that starts as the block ends.
      expect(starts.has(nyAt(key, 12).toISOString())).toBe(true);
      expect(starts.has(nyAt(key, 14).toISOString())).toBe(true);
    }
    const inside = await book(S, nyAt(dayKeyAheadFrom(from, 1), 10));
    expect(inside.status).toBe(400);
    expect(inside.body.error).toBe("invalid_slot");
    const afternoon = await book(S, nyAt(dayKeyAheadFrom(from, 1), 14));
    expect(afternoon.status).toBe(201);
  });

  it("only bookings INSIDE the daily hours are conflicts - an afternoon booking is not in the way of blocked mornings", async () => {
    const from = dayKeyAhead(45);
    const to = dayKeyAheadFrom(from, 1);
    expect((await book(S, nyAt(from, 14), "Afternoon")).status).toBe(201);

    const clear = await postBlock(S, { fromDate: from, toDate: to, fromMin: 9 * 60, toMin: 12 * 60 });
    expect(clear.status).toBe(201);
    expect(clear.body.overlappingAppointments).toBe(0);

    // A booking inside the hours on the SECOND day is.
    expect((await book(S, nyAt(to, 15), "Late")).status).toBe(201);
    const hit = await postBlock(S, { fromDate: from, toDate: to, fromMin: 14 * 60, toMin: 16 * 60 });
    expect(hit.status).toBe(409);
    expect(hit.body.count).toBe(2);
    expect(hit.body.conflicts.join("\n")).toContain("Afternoon Rivera");
    expect(hit.body.conflicts.join("\n")).toContain("Late Rivera");
  });

  it("refuses an inverted or impossible window", async () => {
    const day = dayKeyAhead(50);
    const before = (await blockRows(S)).length;
    const inverted = await postBlock(S, { fromDate: day, toDate: day, fromMin: 12 * 60, toMin: 9 * 60 });
    expect(inverted.status).toBe(400);
    expect(JSON.stringify(inverted.body.issues)).toContain("toMin");
    const tooLate = await postBlock(S, { fromDate: day, toDate: day, fromMin: 9 * 60, toMin: 25 * 60 });
    expect(tooLate.status).toBe(400);
    const halfShape = await postBlock(S, { fromDate: day, toDate: day, fromMin: 9 * 60 });
    expect(halfShape.status).toBe(400);
    expect((await blockRows(S)).length).toBe(before);
  });
});
