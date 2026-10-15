import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  holdAdvisoryLock,
  holdTableLock,
  raceBehindBarrier,
} from "../testing/raceBarrier.js";

/**
 * The whole "Block off time" journey on the real routes: block one barber or
 * several, a day, a repeat or one long absence; see it, change it, take it
 * back - and the one guarantee underneath all of it, that a customer can never
 * book INTO a block, even one committed while their booking was in flight.
 *
 * The shop is pinned to UTC so `at(days, hour)` is the shop's wall clock;
 * repeats across a DST change are pinned in services/blockOff.test.ts.
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

/** `daysAhead` out at `hour`:`min` UTC - always future, never clock-flaky. */
function at(daysAhead: number, hour: number, min = 0): Date {
  const d = new Date(Date.now() + daysAhead * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, min, 0, 0));
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const H = 60;

async function makeShop(label: string) {
  const email = `blockj-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Block", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://bj.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 },
  });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  const staff: string[] = [];
  for (const name of ["Sam", "Lee"]) {
    const s = await prisma.staff.create({ data: { shopId, name }, select: { id: true } });
    staff.push(s.id);
    await prisma.serviceStaff.create({ data: { shopId, serviceId: service.id, staffId: s.id } });
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId,
        staffId: s.id,
        weekday,
        startMin: 9 * H,
        endMin: 17 * H,
      })),
    });
  }
  return {
    cookie,
    shopId,
    slug: me.body.slug as string,
    sam: staff[0]!,
    lee: staff[1]!,
    serviceId: service.id,
  };
}
type Shop = Awaited<ReturnType<typeof makeShop>>;

let phoneSeq = 100;
function book(s: Shop, staffId: string, when: Date) {
  phoneSeq += 1;
  return request(app)
    .post(`/api/book/${s.slug}`)
    .send({
      staffId,
      serviceId: s.serviceId,
      startsAt: when.toISOString(),
      firstName: "Pat",
      lastName: "Rivera",
      phone: `(302) 555-${String(phoneSeq).padStart(4, "0")}`,
      email: `cust${phoneSeq}@example.com`,
    });
}

function block(s: Shop, body: Record<string, unknown>) {
  return request(app).post("/api/booking/blocks").set("Cookie", s.cookie).send(body);
}

const rowsOf = (shopId: string, extra: Record<string, unknown> = {}) =>
  prisma.availabilityException.findMany({
    where: { shopId, ...extra },
    orderBy: [{ startsAt: "asc" }, { staffId: "asc" }],
  });

/** Wait until at least one connection is parked on a lock on `table`. */
async function untilBlockedOn(table: string, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE ${"%" + table + "%"}`;
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

function slotsOn(s: Shop, staffId: string, day: number) {
  return request(app)
    .get(`/api/book/${s.slug}/slots`)
    .query({
      staffId,
      serviceId: s.serviceId,
      from: at(day, 0).toISOString(),
      to: at(day + 1, 0).toISOString(),
    });
}
const startsOf = (res: request.Response) =>
  (res.body.slots as { startsAt: string }[]).map((x) => x.startsAt);

let S: Shop;

beforeAll(async () => {
  S = await makeShop("Block Journey Cuts");
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

describe("a customer can never book into a block", () => {
  it("🔴 a block committed AFTER the customer's slot check refuses the write (holdTableLock race)", async () => {
    const slot = at(3, 10);
    // The slot engine reads ExternalBlock AFTER the barber's own blocks, so a
    // lock on it parks the booking's slot check with "no block here" already
    // in hand. The block is then committed on another connection.
    const barrier = await holdTableLock("ExternalBlock");
    let settled = false;
    const booking = book(S, S.sam, slot).then((r) => {
      settled = true;
      return r;
    });
    expect(await untilBlockedOn("ExternalBlock")).toBe(true);
    const made = await block(S, {
      staffIds: [S.sam],
      when: { kind: "day", date: ymd(slot), fromMin: 9 * H, toMin: 12 * H },
      reason: "Dentist",
    });
    expect(made.status).toBe(201);
    // The booking was really parked: it had not finished before the release.
    expect(settled).toBe(false);
    await barrier.release();
    const res = await booking;
    // Refused by the WRITE guard (a stale read would have said invalid_slot).
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");
    expect(
      await prisma.appointment.count({ where: { shopId: S.shopId, staffId: S.sam, startsAt: slot } }),
    ).toBe(0);
  });
});

describe("blocking several barbers at once", () => {
  it("🔴 checks EVERY chosen barber, names whose booking is in the way, and writes nothing until confirmed", async () => {
    const appt = await book(S, S.lee, at(4, 10));
    expect(appt.status).toBe(201);
    const body = {
      staffIds: [S.sam, S.lee],
      when: { kind: "day", date: ymd(at(4, 0)), fromMin: 9 * H, toMin: 12 * H },
    };
    const refused = await block(S, body);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("appointments_overlap");
    expect(refused.body.count).toBe(1);
    expect(refused.body.conflicts[0]).toMatch(/^Lee · /);
    // Nothing for EITHER barber - Sam's chair was free, but it is one save.
    expect(await prisma.availabilityException.count({ where: { shopId: S.shopId, startsAt: at(4, 9) } })).toBe(0);

    const ok = await block(S, { ...body, confirmation: refused.body.confirmation });
    expect(ok.status).toBe(201);
    expect(ok.body.created).toBe(2);
    expect(ok.body.overlappingAppointments).toBe(1);
    const rows = await rowsOf(S.shopId, { startsAt: at(4, 9) });
    expect(rows.map((r) => r.staffId).sort()).toEqual([S.sam, S.lee].sort());
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    expect(rows[0]!.groupId).toBe(ok.body.groupId);
    // The booking stays exactly as it was.
    const kept = await prisma.appointment.findUniqueOrThrow({ where: { manageToken: appt.body.manageToken } });
    expect(kept.status).toBe("BOOKED");
    expect(kept.startsAt.toISOString()).toBe(at(4, 10).toISOString());
  });

  it("refuses an unknown or another shop's barber without writing anything", async () => {
    const other = await makeShop("Other Block Cuts");
    const res = await block(S, {
      staffIds: [S.sam, other.sam],
      when: { kind: "day", date: ymd(at(5, 0)) },
    });
    expect(res.status).toBe(404);
    expect(await prisma.availabilityException.count({ where: { shopId: S.shopId, startsAt: at(5, 0) } })).toBe(0);
  });
});

describe("a retried save writes once", () => {
  it("🔴 the same requestId answers from the first try's rows", async () => {
    const body = {
      staffIds: [S.sam],
      when: { kind: "daily", fromDate: ymd(at(6, 0)), toDate: ymd(at(8, 0)), fromMin: 13 * H, toMin: 14 * H },
      requestId: `rq_${randomToken(12)}`,
    };
    const first = await block(S, body);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(3);
    const retry = await block(S, body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.created).toBe(3);
    expect(retry.body.groupId).toBe(first.body.groupId);
    expect(await prisma.availabilityException.count({ where: { requestId: body.requestId } })).toBe(3);
  });

  it("🔴 two copies of one save racing on the chair lock: one writes, one replays (holdAdvisoryLock)", async () => {
    const body = {
      staffIds: [S.lee],
      when: { kind: "day", date: ymd(at(9, 0)), fromMin: 15 * H, toMin: 16 * H },
      requestId: `rq_${randomToken(12)}`,
    };
    const barrier = await holdAdvisoryLock(`appt:${S.lee}`);
    const { results, settledEarly } = await raceBehindBarrier(barrier, [
      () => block(S, body),
      () => block(S, body),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
    expect(statuses).toEqual([200, 201]);
    expect(await prisma.availabilityException.count({ where: { requestId: body.requestId } })).toBe(1);
  });

  it("the database refuses a second copy of a save's row outright", async () => {
    const requestId = `rq_${randomToken(12)}`;
    const row = {
      shopId: S.shopId,
      staffId: S.sam,
      startsAt: at(40, 9),
      endsAt: at(40, 10),
      requestId,
    };
    await prisma.availabilityException.create({ data: row });
    await expect(prisma.availabilityException.create({ data: row })).rejects.toThrow();
  });
});

describe("repeat, and one long absence", () => {
  it("repeats the same block weekly, a bounded number of times, as one group", async () => {
    const res = await block(S, {
      staffIds: [S.sam],
      when: { kind: "day", date: ymd(at(10, 0)), fromMin: 12 * H, toMin: 13 * H, repeat: { weeks: 3 } },
      reason: "Lunch",
    });
    expect(res.status).toBe(201);
    const rows = await rowsOf(S.shopId, { groupId: res.body.groupId });
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual([
      at(10, 12).toISOString(),
      at(17, 12).toISOString(),
      at(24, 12).toISOString(),
    ]);
    expect(rows.every((r) => r.pattern === "weekly" && r.reason === "Lunch")).toBe(true);
  });

  it("a continuous absence blocks the whole day between its ends", async () => {
    const res = await block(S, {
      staffIds: [S.lee],
      when: { kind: "continuous", fromDate: ymd(at(11, 0)), fromMin: 15 * H, toDate: ymd(at(13, 0)), toMin: 11 * H },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    // The middle day is gone entirely; the last day opens at 11:00.
    expect((await slotsOn(S, S.lee, 12)).body.slots).toHaveLength(0);
    const last = startsOf(await slotsOn(S, S.lee, 13));
    expect(last[0]).toBe(at(13, 11).toISOString());
  });
});

describe("seeing, changing and removing a block", () => {
  it("reads a block with its whole group: barbers, days, and whether its hours can change together", async () => {
    const made = await block(S, {
      staffIds: [S.sam, S.lee],
      when: { kind: "daily", fromDate: ymd(at(20, 0)), toDate: ymd(at(21, 0)), fromMin: 9 * H, toMin: 10 * H },
      reason: "Training",
    });
    expect(made.status).toBe(201);
    const one = await prisma.availabilityException.findFirstOrThrow({
      where: { groupId: made.body.groupId, staffId: S.sam, startsAt: at(20, 9) },
    });
    const res = await request(app).get(`/api/booking/blocks/${one.id}`).set("Cookie", S.cookie);
    expect(res.status).toBe(200);
    const b = res.body.block;
    expect(b.staffName).toBe("Sam");
    expect(b.reason).toBe("Training");
    expect(b.pattern).toBe("daily");
    expect(b.group.count).toBe(4);
    expect(b.group.staff.map((s: { name: string }) => s.name)).toEqual(["Lee", "Sam"]);
    expect(b.group.days).toEqual([ymd(at(20, 0)), ymd(at(21, 0))]);
    expect(b.group.timesEditable).toBe(true);
  });

  it("🔴 an edit to a new time re-runs the conflict check, and confirming never touches the booking", async () => {
    const appt = await book(S, S.sam, at(22, 14));
    expect(appt.status).toBe(201);
    const made = await block(S, {
      staffIds: [S.sam],
      when: { kind: "day", date: ymd(at(22, 0)), fromMin: 9 * H, toMin: 10 * H },
    });
    const row = await prisma.availabilityException.findFirstOrThrow({ where: { groupId: made.body.groupId } });
    const edit = { scope: "one", timing: { kind: "day", date: ymd(at(22, 0)), fromMin: 13 * H, toMin: 15 * H } };
    const refused = await request(app).patch(`/api/booking/blocks/${row.id}`).set("Cookie", S.cookie).send(edit);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("appointments_overlap");
    // Unchanged until confirmed.
    expect((await prisma.availabilityException.findUniqueOrThrow({ where: { id: row.id } })).startsAt).toEqual(
      at(22, 9),
    );
    const ok = await request(app)
      .patch(`/api/booking/blocks/${row.id}`)
      .set("Cookie", S.cookie)
      .send({ ...edit, confirmation: refused.body.confirmation });
    expect(ok.status).toBe(200);
    const moved = await prisma.availabilityException.findUniqueOrThrow({ where: { id: row.id } });
    expect([moved.startsAt, moved.endsAt]).toEqual([at(22, 13), at(22, 15)]);
    const kept = await prisma.appointment.findUniqueOrThrow({ where: { manageToken: appt.body.manageToken } });
    expect(kept.status).toBe("BOOKED");
    expect(kept.startsAt).toEqual(at(22, 14));
  });

  it("moves the hours of a whole weekly group at once, each on its own day", async () => {
    const made = await block(S, {
      staffIds: [S.lee],
      when: { kind: "day", date: ymd(at(23, 0)), fromMin: 12 * H, toMin: 13 * H, repeat: { weeks: 2 } },
    });
    const [first] = await rowsOf(S.shopId, { groupId: made.body.groupId });
    const res = await request(app)
      .patch(`/api/booking/blocks/${first!.id}`)
      .set("Cookie", S.cookie)
      .send({ scope: "group", timing: { kind: "window", fromMin: 12 * H + 30, toMin: 13 * H + 30 }, reason: "Late lunch" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    const rows = await rowsOf(S.shopId, { groupId: made.body.groupId });
    expect(rows.map((r) => [r.startsAt.toISOString(), r.endsAt.toISOString(), r.reason])).toEqual([
      [at(23, 12, 30).toISOString(), at(23, 13, 30).toISOString(), "Late lunch"],
      [at(30, 12, 30).toISOString(), at(30, 13, 30).toISOString(), "Late lunch"],
    ]);
    // Same rows, edited in place.
    expect(rows[0]!.id).toBe(first!.id);
  });

  it("will not move a continuous absence's hours as a group", async () => {
    const made = await block(S, {
      staffIds: [S.sam],
      when: { kind: "continuous", fromDate: ymd(at(25, 0)), fromMin: 15 * H, toDate: ymd(at(26, 0)), toMin: 11 * H },
    });
    const [first] = await rowsOf(S.shopId, { groupId: made.body.groupId });
    const res = await request(app)
      .patch(`/api/booking/blocks/${first!.id}`)
      .set("Cookie", S.cookie)
      .send({ scope: "group", timing: { kind: "window", fromMin: 9 * H, toMin: 10 * H } });
    expect(res.status).toBe(400);
    // Its note can still change for the whole group.
    const note = await request(app)
      .patch(`/api/booking/blocks/${first!.id}`)
      .set("Cookie", S.cookie)
      .send({ scope: "group", reason: "Conference" });
    expect(note.status).toBe(200);
    expect((await rowsOf(S.shopId, { groupId: made.body.groupId })).map((r) => r.reason)).toEqual([
      "Conference",
      "Conference",
    ]);
  });

  it("removes one block, or the whole group, and never an open window", async () => {
    const made = await block(S, {
      staffIds: [S.sam, S.lee],
      when: { kind: "day", date: ymd(at(27, 0)), fromMin: 9 * H, toMin: 10 * H, repeat: { weeks: 2 } },
    });
    const rows = await rowsOf(S.shopId, { groupId: made.body.groupId });
    expect(rows).toHaveLength(4);
    const one = await request(app).delete(`/api/booking/blocks/${rows[0]!.id}`).set("Cookie", S.cookie);
    expect(one.status).toBe(200);
    expect(one.body.removed).toBe(1);
    const all = await request(app)
      .delete(`/api/booking/blocks/${rows[1]!.id}?scope=group`)
      .set("Cookie", S.cookie);
    expect(all.status).toBe(200);
    expect(all.body.removed).toBe(3);
    expect(await prisma.availabilityException.count({ where: { groupId: made.body.groupId } })).toBe(0);

    // 🔴 An OPEN window shares the table and is not a block: neither delete
    // route may take it.
    const window = await prisma.availabilityException.create({
      data: { shopId: S.shopId, staffId: S.sam, startsAt: at(28, 18), endsAt: at(28, 20), isBlock: false },
    });
    expect((await request(app).delete(`/api/booking/exceptions/${window.id}`).set("Cookie", S.cookie)).status).toBe(404);
    expect((await request(app).delete(`/api/booking/blocks/${window.id}?scope=group`).set("Cookie", S.cookie)).status).toBe(404);
    expect(await prisma.availabilityException.count({ where: { id: window.id } })).toBe(1);
  });

  it("🔴 removing a block never reopens time another block or a booking still holds", async () => {
    const day = 29;
    const wide = await block(S, { staffIds: [S.sam], when: { kind: "day", date: ymd(at(day, 0)), fromMin: 9 * H, toMin: 12 * H } });
    const inner = await block(S, { staffIds: [S.sam], when: { kind: "day", date: ymd(at(day, 0)), fromMin: 10 * H, toMin: 11 * H } });
    expect([wide.status, inner.status]).toEqual([201, 201]);
    // A booking at 11:00, made with the barber's override (dashboard rows can
    // sit under a block): written directly - the grid is what is under test.
    await prisma.appointment.create({
      data: {
        shopId: S.shopId,
        staffId: S.sam,
        serviceId: S.serviceId,
        startsAt: at(day, 11),
        endsAt: at(day, 11, 30),
        status: "BOOKED",
        firstName: "Kai",
        manageToken: randomToken(),
      },
    });
    const wideRow = await prisma.availabilityException.findFirstOrThrow({ where: { groupId: wide.body.groupId } });
    const del = await request(app).delete(`/api/booking/blocks/${wideRow.id}`).set("Cookie", S.cookie);
    expect(del.status).toBe(200);

    const open = startsOf(await slotsOn(S, S.sam, day));
    expect(open).toContain(at(day, 9).toISOString()); // freed
    expect(open).toContain(at(day, 9, 30).toISOString()); // freed
    expect(open).not.toContain(at(day, 10).toISOString()); // the other block
    expect(open).not.toContain(at(day, 10, 30).toISOString()); // the other block
    expect(open).not.toContain(at(day, 11).toISOString()); // the booking
    expect(open).toContain(at(day, 11, 30).toISOString());
    // And the write path agrees with the grid.
    const refused = await book(S, S.sam, at(day, 10));
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the calendar sees a block on every day it covers", () => {
  it("🔴 the agenda returns a block that started BEFORE the window", async () => {
    // One row from the old instant endpoint: 20:00 on day 31 through 08:00 on day 33.
    const res = await request(app)
      .post(`/api/booking/staff/${S.lee}/exceptions`)
      .set("Cookie", S.cookie)
      .send({ startsAt: at(31, 20).toISOString(), endsAt: at(33, 8).toISOString(), isBlock: true });
    expect(res.status).toBe(201);
    const row = await prisma.availabilityException.findFirstOrThrow({
      where: { shopId: S.shopId, staffId: S.lee, startsAt: at(31, 20) },
    });
    const from = at(32, 0).toISOString();
    const to = at(33, 0).toISOString();
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", S.cookie);
    expect(agenda.status).toBe(200);
    const ids = (agenda.body.agenda as { id: string; source: string }[])
      .filter((r) => r.source === "block")
      .map((r) => r.id);
    expect(ids).toContain(row.id);
  });
});
