import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { holdTableLock } from "../testing/raceBarrier.js";

/**
 * Blocking SOME services, not the whole chair - Drick's ask: "no Shape-ups or
 * Kids' cuts from 3 to 6, Haircuts as usual".
 *
 * Every assertion is on the real routes, against one rule
 * (config/blockScope.ts) applied in three places that must agree: the slot
 * grid, the locked write guard, and the block save's own "bookings in the way"
 * check. A Shape-up is refused inside its block; a Haircut over the same
 * minutes is booked; an add-on that carries a Shape-up INTO the block is
 * refused; each member of a party is judged on its own service; a retried
 * save writes once; removing the block reopens the time; and a block of every
 * service still refuses everything.
 *
 * The shop is pinned to UTC, so `at(days, hour)` is the shop's wall clock.
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const H = 60;
const emails: string[] = [];

function at(daysAhead: number, hour: number, min = 0): Date {
  const d = new Date(Date.now() + daysAhead * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, min, 0, 0));
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function makeShop() {
  const email = `svcblk-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Scope", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Scoped Block Cuts", bookingUrl: "https://sb.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    // No lead time, no reschedule cutoff: the block is the only rule in play.
    data: { bookingMode: "native", timezone: "UTC", bookingLeadMinutes: 0, rescheduleCutoffHours: 0 },
  });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  const svc = async (name: string, durationMin: number) =>
    (await prisma.service.create({ data: { shopId, name, durationMin, price: 30 }, select: { id: true } })).id;
  const haircut = await svc("Haircut", 30);
  const shapeUp = await svc("Shape-up", 20);
  const kids = await svc("Kids' cut", 20);
  // Offered by Sam only: blocking it for Sam AND Lee is a mistake to refuse.
  const design = await svc("Beard design", 20);
  const addOn = await prisma.serviceAddOn.create({
    data: { shopId, name: "Hot towel", durationMin: 10, price: 5 },
    select: { id: true },
  });
  const staff: string[] = [];
  for (const name of ["Sam", "Lee"]) {
    const s = await prisma.staff.create({ data: { shopId, name }, select: { id: true } });
    staff.push(s.id);
    for (const serviceId of name === "Sam" ? [haircut, shapeUp, kids, design] : [haircut, shapeUp, kids]) {
      await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId: s.id } });
    }
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId,
        staffId: s.id,
        weekday,
        startMin: 9 * H,
        endMin: 20 * H,
      })),
    });
  }
  return {
    cookie,
    shopId,
    slug: me.body.slug as string,
    sam: staff[0]!,
    lee: staff[1]!,
    haircut,
    shapeUp,
    kids,
    design,
    addOn: addOn.id,
  };
}

let S: Awaited<ReturnType<typeof makeShop>>;
let phoneSeq = 300;

function book(staffId: string, serviceId: string, when: Date, addOnIds?: string[]) {
  phoneSeq += 1;
  return request(app)
    .post(`/api/book/${S.slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: when.toISOString(),
      firstName: "Pat",
      lastName: "Rivera",
      phone: `(302) 555-${String(phoneSeq).padStart(4, "0")}`,
      email: `scope${phoneSeq}@example.com`,
      ...(addOnIds ? { addOnIds } : {}),
    });
}

function block(body: Record<string, unknown>) {
  return request(app).post("/api/booking/blocks").set("Cookie", S.cookie).send(body);
}

/** Shape-ups and Kids' cuts off for Sam, `fromHour`-`toHour` on day `day`. */
function scopedBlock(day: number, fromHour = 15, toHour = 18, extra: Record<string, unknown> = {}) {
  return block({
    staffIds: [S.sam],
    when: { kind: "day", date: ymd(at(day, 0)), fromMin: fromHour * H, toMin: toHour * H },
    serviceIds: [S.shapeUp, S.kids],
    reason: "Kids' party",
    ...extra,
  });
}

function slotsOn(staffId: string, serviceId: string, day: number) {
  return request(app)
    .get(`/api/book/${S.slug}/slots`)
    .query({ staffId, serviceId, from: at(day, 0).toISOString(), to: at(day + 1, 0).toISOString() });
}
const startsOf = (res: request.Response) =>
  (res.body.slots as { startsAt: string }[]).map((x) => x.startsAt);

function directBooking(staffId: string, serviceId: string, startsAt: Date, min: number) {
  return prisma.appointment.create({
    data: {
      shopId: S.shopId,
      staffId,
      serviceId,
      firstName: "Kept",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + min * 60_000),
      manageToken: randomToken(),
    },
  });
}

async function untilBlockedOn(table: string, atLeast = 1, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE ${"%" + table + "%"}`;
    if ((rows[0]?.n ?? 0) >= atLeast) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

beforeAll(async () => {
  S = await makeShop();
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

describe("availability: the grid stops only the blocked services", () => {
  it("🔴 offers no Shape-up or Kids' cut inside 3-6 PM, and every Haircut", async () => {
    expect((await scopedBlock(3)).status).toBe(201);
    const inside = (iso: string, durMin: number) => {
      const s = Date.parse(iso);
      return s < at(3, 18).getTime() && s + durMin * 60_000 > at(3, 15).getTime();
    };
    const shape = startsOf(await slotsOn(S.sam, S.shapeUp, 3));
    const kids = startsOf(await slotsOn(S.sam, S.kids, 3));
    const cut = startsOf(await slotsOn(S.sam, S.haircut, 3));
    expect(shape.length).toBeGreaterThan(0);
    expect(shape.filter((x) => inside(x, 20))).toEqual([]);
    expect(kids.filter((x) => inside(x, 20))).toEqual([]);
    // The minute the block ends, a Shape-up is back.
    expect(shape).toContain(at(3, 18).toISOString());
    // Haircuts straight through it.
    for (const h of [15, 16, 17]) expect(cut).toContain(at(3, h).toISOString());
    // Another chair is untouched.
    expect(startsOf(await slotsOn(S.lee, S.shapeUp, 3))).toContain(at(3, 16).toISOString());
  });
});

describe("booking writes", () => {
  it("🔴 refuses a Shape-up inside the block and books a Haircut at the same minute", async () => {
    expect((await scopedBlock(4)).status).toBe(201);
    const shape = await book(S.sam, S.shapeUp, at(4, 16));
    expect(shape.status).not.toBe(201);
    expect(
      await prisma.appointment.count({ where: { shopId: S.shopId, startsAt: at(4, 16), serviceId: S.shapeUp } }),
    ).toBe(0);
    const cut = await book(S.sam, S.haircut, at(4, 16));
    expect(cut.status).toBe(201);
  });

  it("🔴 a scoped block committed while a Shape-up is in flight refuses it under the lock; a Haircut in the same race books", async () => {
    // Park both bookings' slot checks (the grid reads ExternalBlock after the
    // barber's own blocks), commit the block, release.
    const barrier = await holdTableLock("ExternalBlock");
    let shape: Promise<request.Response>;
    let cut: Promise<request.Response>;
    try {
      shape = book(S.sam, S.shapeUp, at(5, 16)).then((r) => r);
      cut = book(S.sam, S.haircut, at(5, 16, 30)).then((r) => r);
      // BOTH requests parked past their earlier reads - one waiter could be
      // the Haircut alone, and a Shape-up still on its way would be refused by
      // the grid (400) instead of the write guard this test is about.
      expect(await untilBlockedOn("ExternalBlock", 2)).toBe(true);
      const made = await scopedBlock(5);
      expect(made.status).toBe(201);
    } finally {
      await barrier.release();
    }
    const [s, c] = await Promise.all([shape!, cut!]);
    // The grid had already said yes: only the write guard can have refused.
    expect(s.status).toBe(409);
    expect(s.body.error).toBe("slot_taken");
    expect(c.status).toBe(201);
  });

  it("🔴 an add-on that carries a Shape-up INTO the block is refused; the same Shape-up without it ends as the block starts", async () => {
    expect((await scopedBlock(6)).status).toBe(201);
    // 14:40 + 20 min = 15:00 exactly: allowed.
    expect((await book(S.sam, S.shapeUp, at(6, 14, 40))).status).toBe(201);
    // Lee has no block: the same Shape-up + hot towel at 14:40 books there.
    expect((await book(S.lee, S.shapeUp, at(6, 14, 40), [S.addOn])).status).toBe(201);
    await prisma.appointment.deleteMany({ where: { shopId: S.shopId, staffId: S.sam, startsAt: at(6, 14, 40) } });
    const over = await book(S.sam, S.shapeUp, at(6, 14, 40), [S.addOn]);
    expect(over.status).not.toBe(201);
    // A Haircut WITH the add-on inside the block is still a Haircut.
    expect((await book(S.sam, S.haircut, at(6, 16), [S.addOn])).status).toBe(201);
  });

  it("🔴 a client can't reschedule a Shape-up into the block; a Haircut moves in", async () => {
    expect((await scopedBlock(7)).status).toBe(201);
    const shape = await directBooking(S.sam, S.shapeUp, at(7, 10), 20);
    const cut = await directBooking(S.sam, S.haircut, at(7, 11), 30);
    const moveShape = await request(app)
      .post(`/api/book/manage/${shape.manageToken}/reschedule`)
      .send({ startsAt: at(7, 16).toISOString() });
    expect(moveShape.status).not.toBe(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: shape.id } })).startsAt).toEqual(at(7, 10));
    const moveCut = await request(app)
      .post(`/api/book/manage/${cut.manageToken}/reschedule`)
      .send({ startsAt: at(7, 16).toISOString() });
    expect(moveCut.status).toBe(200);
  });

  it("an all-services block still refuses every service (unchanged)", async () => {
    const all = await block({
      staffIds: [S.sam],
      when: { kind: "day", date: ymd(at(8, 0)), fromMin: 15 * H, toMin: 18 * H },
    });
    expect(all.status).toBe(201);
    const row = await prisma.availabilityException.findFirstOrThrow({ where: { shopId: S.shopId, startsAt: at(8, 15) } });
    expect(row.serviceIds).toEqual([]);
    expect((await book(S.sam, S.haircut, at(8, 16))).status).not.toBe(201);
    expect(startsOf(await slotsOn(S.sam, S.haircut, 8))).not.toContain(at(8, 16).toISOString());
  });
});

describe("grouped bookings: each member on its own service", () => {
  const party = (startsAt: Date, services: string[]) => ({
    staffId: S.sam,
    startsAt: startsAt.toISOString(),
    attendees: services.map((serviceId, i) => ({ firstName: `Kid${i}`, serviceId })),
  });

  it("🔴 refuses a Haircut-then-Shape-up party whose Shape-up lands in the block, naming that member", async () => {
    expect((await scopedBlock(9)).status).toBe(201);
    // Haircut 14:30-15:00 (on its own 30-minute grid), then Shape-up 15:00-15:20 - inside.
    const plan = await request(app).post(`/api/book/${S.slug}/group/plan`).send(party(at(9, 14, 30), [S.haircut, S.shapeUp]));
    expect(plan.status).toBe(400);
    expect(plan.body).toMatchObject({ error: "service_not_offered_then", position: 1 });
    const create = await request(app)
      .post(`/api/book/${S.slug}/group`)
      .send({ ...party(at(9, 14, 30), [S.haircut, S.shapeUp]), firstName: "Parent", lastName: "Group", email: `grp-${randomToken(6)}@test.local` });
    expect(create.status).toBe(400);
    expect(create.body.error).toBe("service_not_offered_then");
    expect(await prisma.appointment.count({ where: { shopId: S.shopId, startsAt: at(9, 14, 30) } })).toBe(0);
    // The same two the other way round fit: the Shape-up is done by 15:00.
    const flipped = await request(app).post(`/api/book/${S.slug}/group/plan`).send(party(at(9, 14, 20), [S.shapeUp, S.haircut]));
    expect(flipped.status).toBe(200);
  });

  it("🔴 books a Shape-up-then-Haircut party that ends its Shape-up as the block starts", async () => {
    expect((await scopedBlock(10)).status).toBe(201);
    // Shape-up 14:40-15:00, then Haircut 15:00-15:30 inside the block: fine.
    const create = await request(app)
      .post(`/api/book/${S.slug}/group`)
      .send({ ...party(at(10, 14, 40), [S.shapeUp, S.haircut]), firstName: "Parent", lastName: "Group", email: `grp-${randomToken(6)}@test.local` });
    expect(create.status).toBe(201);
  });

  it("the party picker leaves out starts that would put a blocked service inside the block", async () => {
    expect((await scopedBlock(11)).status).toBe(201);
    const res = await request(app)
      .get(`/api/book/${S.slug}/group/slots`)
      .query({
        staffId: S.sam,
        serviceIds: `${S.haircut},${S.shapeUp}`,
        from: at(11, 0).toISOString(),
        to: at(12, 0).toISOString(),
      });
    expect(res.status).toBe(200);
    const starts = startsOf(res);
    expect(starts).toContain(at(11, 10).toISOString());
    // Haircut then Shape-up: the Shape-up would sit inside 15-18.
    expect(starts).not.toContain(at(11, 15).toISOString());
    expect(starts).not.toContain(at(11, 16).toISOString());
  });
});

describe("saving, changing and removing a scoped block", () => {
  it("🔴 existing appointments: a Haircut is not in a Shape-up block's way; a Shape-up is, and is kept when confirmed", async () => {
    const cut = await directBooking(S.sam, S.haircut, at(12, 16), 30);
    const clear = await scopedBlock(12);
    expect(clear.status).toBe(201);
    expect(clear.body.overlappingAppointments).toBe(0);

    const shape = await directBooking(S.sam, S.shapeUp, at(13, 16), 20);
    const refused = await scopedBlock(13);
    expect(refused.status).toBe(409);
    expect(refused.body.count).toBe(1);
    expect(await prisma.availabilityException.count({ where: { shopId: S.shopId, startsAt: at(13, 15) } })).toBe(0);
    const ok = await scopedBlock(13, 15, 18, { confirmation: refused.body.confirmation });
    expect(ok.status).toBe(201);
    for (const a of [cut, shape]) {
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
      expect(after.status).toBe("BOOKED");
      expect(after.startsAt).toEqual(a.startsAt);
    }
  });

  it("🔴 a retried save writes once and answers from the first try", async () => {
    const requestId = `retry-${randomToken(12)}`;
    const first = await scopedBlock(14, 15, 18, { requestId });
    expect(first.status).toBe(201);
    const again = await scopedBlock(14, 15, 18, { requestId });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const rows = await prisma.availabilityException.findMany({ where: { shopId: S.shopId, requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.serviceIds).toEqual([S.shapeUp, S.kids].sort());
  });

  it("🔴 removing the block reopens the blocked services", async () => {
    expect((await scopedBlock(15)).status).toBe(201);
    expect(startsOf(await slotsOn(S.sam, S.shapeUp, 15))).not.toContain(at(15, 16).toISOString());
    const row = await prisma.availabilityException.findFirstOrThrow({ where: { shopId: S.shopId, startsAt: at(15, 15) } });
    const del = await request(app).delete(`/api/booking/blocks/${row.id}`).set("Cookie", S.cookie);
    expect(del.status).toBe(200);
    expect(startsOf(await slotsOn(S.sam, S.shapeUp, 15))).toContain(at(15, 16).toISOString());
    expect((await book(S.sam, S.shapeUp, at(15, 16))).status).toBe(201);
  });

  it("widening a block to every service re-checks the bookings now in its way; narrowing it does not", async () => {
    const cut = await directBooking(S.sam, S.haircut, at(16, 16), 30);
    expect((await scopedBlock(16)).status).toBe(201);
    const row = await prisma.availabilityException.findFirstOrThrow({ where: { shopId: S.shopId, startsAt: at(16, 15) } });
    const widen = await request(app)
      .patch(`/api/booking/blocks/${row.id}`)
      .set("Cookie", S.cookie)
      .send({ scope: "one", serviceIds: null });
    expect(widen.status).toBe(409);
    expect(widen.body.error).toBe("appointments_overlap");
    expect((await prisma.availabilityException.findUniqueOrThrow({ where: { id: row.id } })).serviceIds).toHaveLength(2);
    const narrow = await request(app)
      .patch(`/api/booking/blocks/${row.id}`)
      .set("Cookie", S.cookie)
      .send({ scope: "one", serviceIds: [S.kids] });
    expect(narrow.status).toBe(200);
    expect((await prisma.availabilityException.findUniqueOrThrow({ where: { id: row.id } })).serviceIds).toEqual([S.kids]);
    // Shape-ups are bookable there again; Kids' cuts are not.
    const inBlock = (iso: string) => Date.parse(iso) >= at(16, 15).getTime() && Date.parse(iso) < at(16, 18).getTime();
    expect(startsOf(await slotsOn(S.sam, S.shapeUp, 16)).filter(inBlock).length).toBeGreaterThan(0);
    expect(startsOf(await slotsOn(S.sam, S.kids, 16)).filter(inBlock)).toEqual([]);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: cut.id } })).status).toBe("BOOKED");
  });

  it("the sheet and the calendar say which services it stops", async () => {
    expect((await scopedBlock(17)).status).toBe(201);
    const row = await prisma.availabilityException.findFirstOrThrow({ where: { shopId: S.shopId, startsAt: at(17, 15) } });
    const sheet = await request(app).get(`/api/booking/blocks/${row.id}`).set("Cookie", S.cookie);
    expect(sheet.status).toBe(200);
    expect(sheet.body.block.scopeLabel).toBe("Shape-up and Kids' cut only");
    expect(sheet.body.block.services.map((s: { name: string }) => s.name).sort()).toEqual(["Kids' cut", "Shape-up"]);
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(at(17, 0).toISOString())}&to=${encodeURIComponent(at(18, 0).toISOString())}`)
      .set("Cookie", S.cookie);
    expect(agenda.status).toBe(200);
    const band = (agenda.body.agenda as { source: string; id: string; blockScope?: string; blockServiceIds?: string[] }[]).find(
      (r) => r.source === "block" && r.id === row.id,
    );
    expect(band?.blockScope).toBe("Shape-up and Kids' cut only");
    expect(band?.blockServiceIds).toHaveLength(2);
  });

  it("refuses an empty list, another shop's service, and a service one chosen provider does not offer", async () => {
    const day = { kind: "day", date: ymd(at(18, 0)), fromMin: 15 * H, toMin: 18 * H };
    const empty = await block({ staffIds: [S.sam], when: day, serviceIds: [] });
    expect(empty.status).toBe(400);
    const foreign = await block({ staffIds: [S.sam], when: day, serviceIds: [`svc_${randomToken(8)}`] });
    expect(foreign.status).toBe(400);
    const notLees = await block({ staffIds: [S.sam, S.lee], when: day, serviceIds: [S.design] });
    expect(notLees.status).toBe(400);
    expect(notLees.body.issues[0].path).toEqual(["serviceIds"]);
    expect(await prisma.availabilityException.count({ where: { shopId: S.shopId, startsAt: at(18, 15) } })).toBe(0);
  });
});
