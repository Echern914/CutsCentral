import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { complementSpans, openingStartMinutes } from "../engines/specialDay.js";

/**
 * SPECIAL DAY (Drick: "if I want to completely modify how my Thanksgiving day
 * looks ... make all cuts (20 min long) only on that day and charge $65 all
 * day, I need that option").
 *
 * Pinned end to end on the real routes, shop tz = UTC so wall == UTC:
 *   - preview counts the openings and writes nothing
 *   - publish creates them as targeted slots under one rule, and blocks the
 *     rest of the chair's day - so the normal grid is closed while every
 *     special opening is still offered AND bookable
 *   - an opening over an existing booking is left out and reported; the
 *     booking is untouched
 *   - a double publish replays (same request id) or is refused (any other)
 *   - remove takes down unbooked openings and the blocks, keeps booked ones
 * plus the named, one-transaction holiday save.
 */
const app = createApp();
const email = `sd-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let cutId: string;
let beardId: string;

function daysOut(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00.000Z`);

function body(date: string, extra: Record<string, unknown> = {}) {
  return {
    date,
    staffIds: [staffId],
    start: "09:00",
    end: "17:00",
    cutMin: 20,
    price: 65,
    serviceIds: [cutId],
    name: "Thanksgiving",
    ...extra,
  };
}

const dash = (method: "get" | "post" | "put" | "patch" | "delete", path: string) =>
  request(app)[method](`/api/booking${path}`).set("Cookie", cookie);

/** Every slot the public /day offers for one service: normal and special. */
async function daySlots(date: string, serviceId: string) {
  const res = await request(app).get(`/api/book/${slug}/day`).query({ date });
  expect(res.status).toBe(200);
  type S = { id: string; slots: { startsAt: string; targeted?: { id: string; price: number; label: string | null } }[] };
  const all: S[] = [
    ...(res.body.bundles as { services: S[] }[]).flatMap((b) => b.services),
    ...(res.body.ungrouped as S[]),
  ];
  const svc = all.find((s) => s.id === serviceId);
  const slots = svc?.slots ?? [];
  return {
    normal: slots.filter((s) => !s.targeted),
    special: slots.filter((s) => s.targeted),
  };
}

function book(startsAt: Date, serviceId: string, targetedSlotId?: string) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      ...(targetedSlotId ? { targetedSlotId } : {}),
      firstName: `C${randomToken(4)}`,
      lastName: "Tester",
      email: `c-${randomToken(6)}@test.local`,
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
    .send({ name: "Special Day Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;
  staffId = (await dash("post", "/staff").send({ name: "Drick" })).body.id;
  cutId = (await dash("post", "/services").send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] })).body.id;
  beardId = (await dash("post", "/services").send({ name: "Beard", durationMin: 30, price: 25, staffIds: [staffId] })).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  expect((await dash("put", `/staff/${staffId}/availability`).send({ rules })).status).toBe(200);
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("opening maths", () => {
  it("packs cut + buffer while the whole owned span fits", () => {
    expect(openingStartMinutes({ startMin: 540, endMin: 1020, cutMin: 20, bufferMin: 0 })).toHaveLength(24);
    const withBuffer = openingStartMinutes({ startMin: 540, endMin: 1020, cutMin: 20, bufferMin: 5 });
    expect(withBuffer.slice(0, 3)).toEqual([540, 565, 590]);
    expect(withBuffer[withBuffer.length - 1]! + 25).toBeLessThanOrEqual(1020);
  });
  it("blocks exactly the minutes no opening owns", () => {
    const start = new Date("2026-11-26T00:00:00Z");
    const end = new Date("2026-11-27T00:00:00Z");
    const h = (n: number) => start.getTime() + n * 3_600_000;
    expect(
      complementSpans(start, end, [
        { start: h(9), end: h(10) },
        { start: h(10), end: h(11) },
        { start: h(12), end: h(13) },
      ]).map((b) => [b.startsAt.getUTCHours(), b.endsAt.getTime() === end.getTime() ? 24 : b.endsAt.getUTCHours()]),
    ).toEqual([
      [0, 9],
      [11, 12],
      [13, 24],
    ]);
  });
});

describe("publishing a special day", () => {
  const date = daysOut(6);
  let ruleId: string;
  const requestId = `sd_${randomToken(12)}`;

  it("previews 24 openings at 20 minutes and writes nothing", async () => {
    const res = await dash("post", "/special-days/preview").send(body(date));
    expect(res.status).toBe(200);
    const plan = res.body.plans[0];
    expect(plan.openings).toHaveLength(24);
    expect(plan.openings[0]).toBe(at(date, "09:00").toISOString());
    expect(plan.openings[1]).toBe(at(date, "09:20").toISOString());
    expect(plan.openings[23]).toBe(at(date, "16:40").toISOString());
    expect(plan.skipped).toEqual([]);
    expect(await prisma.targetedSlot.count({ where: { shopId } })).toBe(0);
  });

  it("before publishing, the normal grid is open that day", async () => {
    const { normal } = await daySlots(date, cutId);
    expect(normal.length).toBeGreaterThan(0);
  });

  it("publishes the openings and blocks the rest of the chair's day, in one go", async () => {
    const res = await dash("post", "/special-days").send(body(date, { requestId, expectOpenings: 24 }));
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].openings).toBe(24);
    ruleId = res.body.created[0].ruleId;

    const slots = await prisma.targetedSlot.findMany({ where: { shopId, ruleId }, orderBy: { startsAt: "asc" } });
    expect(slots).toHaveLength(24);
    expect(slots.every((s) => Number(s.price) === 65 && s.durationMin === 20 && s.label === "Thanksgiving")).toBe(true);
    const blocks = await prisma.availabilityException.findMany({
      where: { shopId, groupId: ruleId },
      orderBy: { startsAt: "asc" },
    });
    expect(blocks.map((b) => [b.startsAt.toISOString(), b.endsAt.toISOString()])).toEqual([
      [at(date, "00:00").toISOString(), at(date, "09:00").toISOString()],
      [at(date, "17:00").toISOString(), new Date(at(date, "00:00").getTime() + 86_400_000).toISOString()],
    ]);
  });

  it("the public page offers ONLY the special openings that day", async () => {
    const cut = await daySlots(date, cutId);
    expect(cut.normal).toEqual([]);
    expect(cut.special).toHaveLength(24);
    expect(cut.special[0]!.targeted!.price).toBe(65);
    // A service the day does not count as has nothing at all.
    const beard = await daySlots(date, beardId);
    expect(beard.normal).toEqual([]);
    expect(beard.special).toEqual([]);
    // The flat payload lists them too (none were dropped as "blocked").
    const flat = await request(app).get(`/api/book/${slug}`);
    const ids = new Set((flat.body.targetedSlots as { id: string }[]).map((t) => t.id));
    const mine = await prisma.targetedSlot.findMany({ where: { ruleId }, select: { id: true } });
    expect(mine.every((m) => ids.has(m.id))).toBe(true);
  });

  it("a special opening books; a normal booking that day is refused", async () => {
    const slot = await prisma.targetedSlot.findFirstOrThrow({
      where: { ruleId, startsAt: at(date, "09:20") },
    });
    const ok = await book(slot.startsAt, cutId, slot.id);
    expect(ok.status).toBe(201);
    // ...and the one right after it still books (spacing = cut + buffer).
    const next = await prisma.targetedSlot.findFirstOrThrow({ where: { ruleId, startsAt: at(date, "09:40") } });
    expect((await book(next.startsAt, cutId, next.id)).status).toBe(201);

    // Normal grid, inside the window and outside it: both refused.
    expect((await book(at(date, "12:00"), beardId)).status).toBe(409);
    expect((await book(at(date, "08:00"), cutId)).status).toBeGreaterThanOrEqual(400);
  });

  it("the same request again replays without writing anything", async () => {
    const res = await dash("post", "/special-days").send(body(date, { requestId, expectOpenings: 24 }));
    expect(res.status).toBe(200);
    expect(res.body.replay).toBe(true);
    expect(await prisma.targetedSlot.count({ where: { shopId, ruleId } })).toBe(24);
    expect(await prisma.targetedSlotRule.count({ where: { shopId } })).toBe(1);
  });

  it("a second, different publish onto that chair and date is refused", async () => {
    const res = await dash("post", "/special-days").send(body(date, { price: 80 }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_exists");
    expect(await prisma.targetedSlotRule.count({ where: { shopId } })).toBe(1);
  });

  it("is listed, and the series editor will not reshape it", async () => {
    const list = await dash("get", "/special-days");
    expect(list.status).toBe(200);
    const row = (list.body.specialDays as { ruleId: string; date: string; name: string; openings: number; booked: number }[])
      .find((r) => r.ruleId === ruleId);
    expect(row).toMatchObject({ date, name: "Thanksgiving", openings: 24, booked: 2 });
    const patch = await dash("patch", `/targeted-slots/rules/${ruleId}`).send({ price: 10 });
    expect(patch.status).toBe(409);
    const targeted = await dash("get", "/targeted-slots");
    expect((targeted.body.rules as { id: string; specialDay: boolean }[]).find((r) => r.id === ruleId)?.specialDay).toBe(true);
  });

  it("remove takes down unbooked openings and the blocks, and keeps the booked ones", async () => {
    const res = await dash("post", "/special-days/remove").send({ ruleIds: [ruleId] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removed: 1, openingsRemoved: 22, bookedKept: 2 });
    const left = await prisma.targetedSlot.findMany({ where: { ruleId } });
    expect(left).toHaveLength(2);
    expect(left.every((s) => s.bookedAppointmentId !== null)).toBe(true);
    const appts = await prisma.appointment.findMany({ where: { shopId, staffId, startsAt: { gte: at(date, "00:00") } } });
    expect(appts.filter((a) => a.status === "BOOKED")).toHaveLength(2);
    expect(await prisma.availabilityException.count({ where: { groupId: ruleId } })).toBe(0);
    // The normal schedule is back.
    const { normal } = await daySlots(date, cutId);
    expect(normal.length).toBeGreaterThan(0);
  });
});

describe("a chair that already has bookings that day", () => {
  const date = daysOut(8);

  it("leaves out the openings that would overlap and keeps the booking", async () => {
    const existing = await book(at(date, "10:00"), cutId); // a normal 30-min cut, 10:00-10:30
    expect(existing.status).toBe(201);

    const preview = await dash("post", "/special-days/preview").send(body(date));
    expect(preview.status).toBe(200);
    const plan = preview.body.plans[0];
    expect(plan.openings).toHaveLength(22);
    expect(plan.skipped).toEqual([
      { startsAt: at(date, "10:00").toISOString(), reason: "booking" },
      { startsAt: at(date, "10:20").toISOString(), reason: "booking" },
    ]);
    expect(plan.bookings).toHaveLength(1);

    // A publish expecting the old count is refused and writes nothing.
    const stale = await dash("post", "/special-days").send(body(date, { expectOpenings: 24 }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("changed");
    expect(await prisma.targetedSlotRule.count({ where: { shopId, active: true } })).toBe(0);

    const res = await dash("post", "/special-days").send(body(date, { expectOpenings: 22 }));
    expect(res.status).toBe(201);
    const ruleId = res.body.created[0].ruleId as string;
    const starts = (await prisma.targetedSlot.findMany({ where: { ruleId }, select: { startsAt: true } })).map((s) =>
      s.startsAt.toISOString(),
    );
    expect(starts).not.toContain(at(date, "10:00").toISOString());
    expect(starts).not.toContain(at(date, "10:20").toISOString());
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, staffId, startsAt: at(date, "10:00") } });
    expect(appt.status).toBe("BOOKED");

    // Removing the series from the Targeted slots card takes its blocks too.
    expect((await dash("delete", `/targeted-slots/rules/${ruleId}`)).status).toBe(200);
    expect(await prisma.availabilityException.count({ where: { groupId: ruleId } })).toBe(0);
  });
});

describe("with a turnover buffer", () => {
  const date = daysOut(10);

  it("spaces openings by cut + buffer so back-to-back ones both book", async () => {
    expect((await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingBufferMin: 5 })).status).toBe(200);
    try {
      const res = await dash("post", "/special-days").send(body(date, { start: "09:00", end: "10:15" }));
      expect(res.status).toBe(201);
      const ruleId = res.body.created[0].ruleId as string;
      const slots = await prisma.targetedSlot.findMany({ where: { ruleId }, orderBy: { startsAt: "asc" } });
      // 9:00, 9:25, 9:50 - each owns 25 minutes, the last ends its tail at 10:15.
      expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
        at(date, "09:00").toISOString(),
        at(date, "09:25").toISOString(),
        at(date, "09:50").toISOString(),
      ]);
      for (const slot of slots) {
        expect((await book(slot.startsAt, cutId, slot.id)).status).toBe(201);
      }
    } finally {
      await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingBufferMin: 0 });
    }
  });
});

describe("deleting single openings of a special day", () => {
  const date = daysOut(12);

  it("keeps their spans closed: no normal slot appears inside the day", async () => {
    const res = await dash("post", "/special-days").send(body(date));
    expect(res.status).toBe(201);
    const ruleId = res.body.created[0].ruleId as string;
    const slotAt = (hhmm: string) => prisma.targetedSlot.findFirstOrThrow({ where: { ruleId, startsAt: at(date, hhmm) } });

    // One by the single delete, two by the bulk delete.
    const noon = await slotAt("12:00");
    expect((await dash("delete", `/targeted-slots/${noon.id}`)).status).toBe(200);
    const bulk = await dash("post", "/targeted-slots/bulk-delete").send({
      ids: [(await slotAt("13:00")).id, (await slotAt("13:20")).id],
    });
    expect(bulk.body.removed).toBe(2);

    // The holes are closed, not handed back to the normal grid.
    const cut = await daySlots(date, cutId);
    expect(cut.normal).toEqual([]);
    expect(cut.special).toHaveLength(21);
    expect((await daySlots(date, beardId)).normal).toEqual([]);
    expect((await book(at(date, "12:00"), cutId)).status).toBeGreaterThanOrEqual(400);
    expect((await book(at(date, "13:00"), beardId)).status).toBeGreaterThanOrEqual(400);
    // The neighbours still book.
    const before = await slotAt("11:40");
    expect((await book(before.startsAt, cutId, before.id)).status).toBe(201);
    const after = await slotAt("12:20");
    expect((await book(after.startsAt, cutId, after.id)).status).toBe(201);

    // Moving one opening would open a hole too: refused.
    const moved = await dash("patch", `/targeted-slots/${(await slotAt("15:00")).id}`).send({ price: 10 });
    expect(moved.status).toBe(409);

    // Removing the whole day still cleans up every block, these included.
    expect((await dash("post", "/special-days/remove").send({ ruleIds: [ruleId] })).status).toBe(200);
    expect(await prisma.availabilityException.count({ where: { groupId: ruleId } })).toBe(0);
    expect((await daySlots(date, beardId)).normal.length).toBeGreaterThan(0);
  });
});

describe("named holidays, saved in one transaction", () => {
  const d1 = daysOut(20);
  const d2 = daysOut(21);

  async function services() {
    const res = await dash("get", "/services");
    expect(res.status).toBe(200);
    const byId = new Map((res.body.services as { id: string; dateOverrides: Record<string, number> }[]).map((s) => [s.id, s]));
    return { names: res.body.holidayNames as Record<string, string>, cut: byId.get(cutId)!, beard: byId.get(beardId)! };
  }

  it("adds a named holiday on the chosen services", async () => {
    const res = await dash("put", "/holidays").send({ dates: [d1], price: 75, serviceIds: [cutId, beardId], name: "Thanksgiving" });
    expect(res.status).toBe(200);
    const s = await services();
    expect(s.names[d1]).toBe("Thanksgiving");
    expect(s.cut.dateOverrides[d1]).toBe(75);
    expect(s.beard.dateOverrides[d1]).toBe(75);
  });

  it("edit moves the date, re-prices, renames and drops a service - all at once", async () => {
    const res = await dash("put", "/holidays").send({
      removeDates: [d1],
      dates: [d2],
      price: 90,
      serviceIds: [cutId],
      name: "Black Friday",
    });
    expect(res.status).toBe(200);
    const s = await services();
    expect(s.names).toEqual({ [d2]: "Black Friday" });
    expect(s.cut.dateOverrides).toEqual({ [d2]: 90 });
    expect(s.beard.dateOverrides).toEqual({});
  });

  it("a refused save changes nothing", async () => {
    const res = await dash("put", "/holidays").send({
      removeDates: [d2],
      dates: [d1],
      price: 50,
      serviceIds: [cutId, "not-a-service"],
      name: "Oops",
    });
    expect(res.status).toBe(400);
    const s = await services();
    expect(s.names).toEqual({ [d2]: "Black Friday" });
    expect(s.cut.dateOverrides).toEqual({ [d2]: 90 });
  });

  it("remove clears the prices and the name", async () => {
    expect((await dash("put", "/holidays").send({ removeDates: [d2] })).status).toBe(200);
    const s = await services();
    expect(s.names).toEqual({});
    expect(s.cut.dateOverrides).toEqual({});
  });
});
