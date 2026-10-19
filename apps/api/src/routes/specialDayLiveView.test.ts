import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE LIVE VIEW of a special day (Drick, on the Holiday pricing card: "This
 * should show the 'open live view' so I can select specific prices and TIMES
 * available for that day").
 *
 * Pinned end to end on the real routes, shop tz = UTC so wall == UTC:
 *   - the view draws what is already there (a booking) and the normal hours
 *   - a save writes exactly the openings sent, each at ITS OWN price, and the
 *     booking page sells each at that price while the normal grid is closed
 *   - an opening over a booking is refused, and nothing is written
 *   - a stale view (the day changed) is refused with the fresh view
 *   - a booked opening is never removed or re-priced, whatever the save says
 *   - tap-to-add, tap-to-remove and re-price all go through the same save
 *   - a retried save replays; a chair left empty goes back to normal hours
 *   - a day published from the old builder opens and edits the same way
 */
const app = createApp();
const email = `sdlv-${randomToken(6)}@test.local`.toLowerCase();
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
const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const dash = (method: "get" | "post" | "put" | "patch" | "delete", path: string) =>
  request(app)[method](`/api/booking${path}`).set("Cookie", cookie);

interface View {
  basis: string;
  name: string | null;
  serviceIds: string[];
  chairs: {
    staffId: string;
    ruleIds: string[];
    hours: { startMin: number; endMin: number }[];
    openings: { id: string; startMin: number; durationMin: number; price: number; booked: boolean }[];
    bookings: { startMin: number; endMin: number; label: string }[];
    blocks: { startMin: number; endMin: number; label: string }[];
  }[];
}

async function view(date: string): Promise<View> {
  const res = await dash("get", `/special-days/day?date=${date}`);
  expect(res.status).toBe(200);
  return res.body.view as View;
}

function save(
  date: string,
  v: View,
  openings: { id?: string; startMin: number; durationMin: number; price: number }[],
  extra: Record<string, unknown> = {},
) {
  return dash("put", "/special-days/day").send({
    date,
    name: "Thanksgiving",
    serviceIds: [cutId],
    basis: v.basis,
    chairs: [{ staffId, openings }],
    ...extra,
  });
}

/** Every slot the public /day offers for one service: normal and special. */
async function daySlots(date: string, serviceId: string) {
  const res = await request(app).get(`/api/book/${slug}/day`).query({ date });
  expect(res.status).toBe(200);
  type S = { id: string; slots: { startsAt: string; targeted?: { id: string; price: number } }[] };
  const all: S[] = [
    ...(res.body.bundles as { services: S[] }[]).flatMap((b) => b.services),
    ...(res.body.ungrouped as S[]),
  ];
  const slots = all.find((s) => s.id === serviceId)?.slots ?? [];
  return { normal: slots.filter((s) => !s.targeted), special: slots.filter((s) => s.targeted) };
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
    .send({ name: "Live View Cuts", bookingUrl: "https://book.test", smsAttested: true });
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

describe("the live view of one day", () => {
  const date = daysOut(6);

  it("draws the normal hours and a booking already there, and no openings yet", async () => {
    expect((await book(at(date, "11:00"), cutId)).status).toBe(201);
    const v = await view(date);
    const chair = v.chairs.find((c) => c.staffId === staffId)!;
    expect(chair.hours).toEqual([{ startMin: 540, endMin: 1020 }]);
    expect(chair.openings).toEqual([]);
    expect(chair.ruleIds).toEqual([]);
    expect(chair.bookings).toHaveLength(1);
    expect(chair.bookings[0]).toMatchObject({ startMin: min("11:00"), endMin: min("11:30") });
    expect(chair.bookings[0]!.label).toMatch(/^Booked: .* - Cut$/);
    expect(v.basis).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses an opening over that booking and writes nothing", async () => {
    const v = await view(date);
    const res = await save(date, v, [
      { startMin: min("09:00"), durationMin: 20, price: 65 },
      { startMin: min("11:10"), durationMin: 20, price: 65 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_opening", reason: "booking", startMin: min("11:10") });
    expect(await prisma.targetedSlot.count({ where: { shopId } })).toBe(0);
    expect(await prisma.availabilityException.count({ where: { shopId } })).toBe(0);
  });

  it("refuses two openings that overlap each other", async () => {
    const v = await view(date);
    const res = await save(date, v, [
      { startMin: min("09:00"), durationMin: 20, price: 65 },
      { startMin: min("09:10"), durationMin: 20, price: 65 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("opening");
    expect(await prisma.targetedSlot.count({ where: { shopId } })).toBe(0);
  });

  it("saves openings at their OWN prices; the booking page sells exactly those", async () => {
    const v = await view(date);
    const res = await save(date, v, [
      { startMin: min("09:00"), durationMin: 20, price: 65 },
      { startMin: min("09:20"), durationMin: 20, price: 65 },
      { startMin: min("09:40"), durationMin: 20, price: 80 },
      { startMin: min("13:00"), durationMin: 20, price: 50 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ added: 4, removed: 0 });
    const chair = (res.body.view as View).chairs.find((c) => c.staffId === staffId)!;
    expect(chair.openings.map((o) => [o.startMin, o.price])).toEqual([
      [min("09:00"), 65],
      [min("09:20"), 65],
      [min("09:40"), 80],
      [min("13:00"), 50],
    ]);
    expect(chair.ruleIds).toHaveLength(1);
    // The booking that was already there stays exactly as it was.
    expect(chair.bookings).toHaveLength(1);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, startsAt: at(date, "11:00") } });
    expect(appt.status).toBe("BOOKED");

    const cut = await daySlots(date, cutId);
    expect(cut.normal).toEqual([]);
    expect(cut.special.map((s) => [s.startsAt, s.targeted!.price])).toEqual([
      [at(date, "09:00").toISOString(), 65],
      [at(date, "09:20").toISOString(), 65],
      [at(date, "09:40").toISOString(), 80],
      [at(date, "13:00").toISOString(), 50],
    ]);
    // A service the day does not count as: nothing at all that day.
    expect(await daySlots(date, beardId)).toEqual({ normal: [], special: [] });
    // The rest of the day is closed by special-day blocks, never over an opening.
    const blocks = await prisma.availabilityException.findMany({
      where: { shopId, pattern: "special_day" },
      orderBy: { startsAt: "asc" },
    });
    expect(blocks.map((b) => [b.startsAt.toISOString(), b.endsAt.toISOString()])).toEqual([
      [at(date, "00:00").toISOString(), at(date, "09:00").toISOString()],
      [at(date, "10:00").toISOString(), at(date, "13:00").toISOString()],
      [at(date, "13:20").toISOString(), new Date(at(date, "00:00").getTime() + 86_400_000).toISOString()],
    ]);
  });

  it("refuses a save made against a view that is out of date, and writes nothing", async () => {
    const stale = await view(date);
    // A client books the 9:40 opening ($80) after the barber opened the view.
    const slot = await prisma.targetedSlot.findFirstOrThrow({ where: { shopId, startsAt: at(date, "09:40") } });
    expect((await book(slot.startsAt, cutId, slot.id)).status).toBe(201);

    const res = await save(date, stale, []);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("changed");
    const fresh = (res.body.view as View).chairs.find((c) => c.staffId === staffId)!;
    expect(fresh.openings.find((o) => o.startMin === min("09:40"))).toMatchObject({ booked: true, price: 80 });
    expect(await prisma.targetedSlot.count({ where: { shopId } })).toBe(4);
  });

  it("never re-prices a booked opening", async () => {
    const v = await view(date);
    const booked = v.chairs[0]!.openings.find((o) => o.booked)!;
    const res = await save(
      date,
      v,
      v.chairs[0]!.openings.map((o) => (o.id === booked.id ? { ...o, price: 10 } : o)).map(strip),
    );
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("booked_opening");
    const row = await prisma.targetedSlot.findUniqueOrThrow({ where: { id: booked.id } });
    expect(Number(row.price)).toBe(80);
  });

  it("removes, re-prices and adds in one save - and a booked opening left out stays booked", async () => {
    const v = await view(date);
    const o = v.chairs[0]!.openings;
    const nine = o.find((x) => x.startMin === min("09:00"))!;
    const one = o.find((x) => x.startMin === min("13:00"))!;
    const requestId = `lv_${randomToken(14)}`;
    const res = await save(
      date,
      v,
      [
        // 9:00 re-priced, 9:20 tapped off, 9:40 (booked) not even sent,
        // 13:00 kept, 15:00 tapped in.
        { ...strip(nine), price: 70 },
        strip(one),
        { startMin: min("15:00"), durationMin: 20, price: 65 },
      ],
      { requestId },
    );
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ added: 1, removed: 1, repriced: 1, bookedKept: 1 });
    const chair = (res.body.view as View).chairs[0]!;
    expect(chair.openings.map((x) => [x.startMin, x.price, x.booked])).toEqual([
      [min("09:00"), 70, false],
      [min("09:40"), 80, true],
      [min("13:00"), 50, false],
      [min("15:00"), 65, false],
    ]);
    const cut = await daySlots(date, cutId);
    expect(cut.normal).toEqual([]);
    expect(cut.special.map((s) => [s.startsAt, s.targeted!.price])).toEqual([
      [at(date, "09:00").toISOString(), 70],
      [at(date, "13:00").toISOString(), 50],
      [at(date, "15:00").toISOString(), 65],
    ]);
    // The removed 9:20 is closed, not handed back to the normal grid.
    expect((await book(at(date, "09:20"), beardId)).status).toBeGreaterThanOrEqual(400);

    // The same request again (a lost answer, a double tap) replays.
    const again = await save(date, v, [{ ...strip(nine), price: 70 }], { requestId });
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(await prisma.targetedSlot.count({ where: { shopId } })).toBe(4);
  });

  it("a chair left with no unbooked openings keeps its booked one and stays closed", async () => {
    const v = await view(date);
    const res = await save(date, v, []);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ removed: 3, bookedKept: 1 });
    const chair = (res.body.view as View).chairs[0]!;
    expect(chair.openings.map((x) => [x.startMin, x.booked])).toEqual([[min("09:40"), true]]);
    expect((await daySlots(date, cutId)).normal).toEqual([]);
    // Both bookings that day are still booked.
    const appts = await prisma.appointment.findMany({ where: { shopId, startsAt: { gte: at(date, "00:00") } } });
    expect(appts.filter((a) => a.status === "BOOKED")).toHaveLength(2);
  });
});

describe("a chair with no openings at all", () => {
  const date = daysOut(9);

  it("goes back to its normal schedule", async () => {
    const v = await view(date);
    expect((await save(date, v, [{ startMin: min("10:00"), durationMin: 20, price: 65 }])).status).toBe(200);
    expect((await daySlots(date, cutId)).normal).toEqual([]);

    const res = await save(date, await view(date), []);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ removed: 1, bookedKept: 0 });
    expect((res.body.view as View).chairs[0]!.ruleIds).toEqual([]);
    expect(await prisma.availabilityException.count({ where: { shopId, pattern: "special_day", startsAt: { gte: at(date, "00:00") } } })).toBe(0);
    expect((await daySlots(date, cutId)).normal.length).toBeGreaterThan(0);
  });
});

describe("a day published from the Special day builder", () => {
  const date = daysOut(11);

  it("opens in the live view and edits there", async () => {
    const pub = await dash("post", "/special-days").send({
      date,
      staffIds: [staffId],
      start: "09:00",
      end: "10:00",
      cutMin: 20,
      price: 65,
      serviceIds: [cutId, beardId],
      name: "Black Friday",
    });
    expect(pub.status).toBe(201);
    const v = await view(date);
    expect(v.name).toBe("Black Friday");
    expect(v.serviceIds.sort()).toEqual([cutId, beardId].sort());
    const o = v.chairs[0]!.openings;
    expect(o.map((x) => x.startMin)).toEqual([min("09:00"), min("09:20"), min("09:40")]);

    // Re-price the last one: a "specific price" on one opening.
    const res = await dash("put", "/special-days/day").send({
      date,
      name: "Black Friday",
      serviceIds: [cutId, beardId],
      basis: v.basis,
      chairs: [{ staffId, openings: o.map((x) => (x.startMin === min("09:40") ? { ...strip(x), price: 90 } : strip(x))) }],
    });
    expect(res.status).toBe(200);
    const beard = await daySlots(date, beardId);
    expect(beard.special.map((s) => s.targeted!.price)).toEqual([65, 65, 90]);
  });

  it("refuses a date already behind the shop", async () => {
    const res = await dash("get", `/special-days/day?date=${daysOut(-2)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("in_the_past");
  });
});

function strip(o: { id: string; startMin: number; durationMin: number; price: number }) {
  return { id: o.id, startMin: o.startMin, durationMin: o.durationMin, price: o.price };
}
