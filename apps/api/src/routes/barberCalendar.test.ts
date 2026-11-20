import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindAdvisoryLock, winners } from "../testing/raceBarrier.js";

/**
 * A team member's own calendar: /api/barber/calendar.
 *
 * The property under test everywhere is the same one: WHOSE calendar this is
 * comes from the session and from nowhere else. So nearly every test has two
 * people in one shop - Dev, who is signed in, and Marcus, who is not - and
 * checks that nothing Dev sends (a query param, a body field, an id copied
 * from somewhere) reads or changes anything of Marcus's.
 *
 * Each guard here was proven by removing it and watching its test go red; the
 * tests are named for the guard they hold.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const BASE = "/api/barber/calendar";

let ownerCookie: string;
let shopId: string;
let slug: string;
let dev: string; // the signed-in team member's staff row
let marcus: string; // a colleague's
let fadeId: string; // offered by both
let colourId: string; // offered by Marcus only
let devCookie: string;
let seatlessCookie: string; // a team login with no staff row behind it

/** A fixed UTC hour, `days` from today. The shop is in UTC. */
function at(days: number, hour: number, min = 0): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const opId = () => randomToken(16);

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

async function seed(
  staffId: string,
  startsAt: Date,
  who: string,
  extra: { status?: "BOOKED" | "COMPLETED" | "CANCELED"; clientId?: string } = {},
) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: fadeId,
      firstName: who,
      status: extra.status ?? "BOOKED",
      clientId: extra.clientId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(16),
    },
  });
}

async function seedBlock(staffId: string, startsAt: Date, hours: number, groupId?: string) {
  return prisma.availabilityException.create({
    data: {
      shopId,
      staffId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + hours * 3_600_000),
      isBlock: true,
      reason: "Away",
      groupId,
    },
  });
}

const asDev = {
  get: (path: string) => request(app).get(`${BASE}${path}`).set("Cookie", devCookie),
  post: (path: string, body: object) =>
    request(app).post(`${BASE}${path}`).set("Cookie", devCookie).send(body),
  put: (path: string, body: object) =>
    request(app).put(`${BASE}${path}`).set("Cookie", devCookie).send(body),
  del: (path: string) => request(app).delete(`${BASE}${path}`).set("Cookie", devCookie),
};

beforeAll(async () => {
  const owner = await signup("bc-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Own Calendar Cuts", smsAttested: true });
  shopId = shop.body.id;
  slug = shop.body.slug;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC" });

  const a = await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Dev" });
  dev = a.body.id;
  const b = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Marcus" });
  marcus = b.body.id;

  const fade = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [dev, marcus] });
  fadeId = fade.body.id;
  const colour = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Colour", durationMin: 60, price: 90, staffIds: [marcus] });
  colourId = colour.body.id;

  // Both work 08:00-20:00 every day.
  for (const staffId of [dev, marcus]) {
    for (let weekday = 0; weekday < 7; weekday++) {
      await prisma.availabilityRule.create({
        data: { shopId, staffId, weekday, startMin: 8 * 60, endMin: 20 * 60 },
      });
    }
  }

  const member = await signup("bc-dev");
  devCookie = member.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: member.userId, role: "BARBER", staffId: dev },
  });

  const seatless = await signup("bc-seatless");
  seatlessCookie = seatless.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: seatless.userId, role: "BARBER", staffId: null },
  });
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

describe("who may use it", () => {
  it("a signed-out caller gets nothing", async () => {
    const res = await request(app).get(`${BASE}/day`);
    expect(res.status).toBe(401);
  });

  it("🔴 a team login with no staff row behind it is refused on every route", async () => {
    const day = dayKey(at(3, 0));
    const calls = [
      request(app).get(`${BASE}/day`),
      request(app).get(`${BASE}/hours`),
      request(app).put(`${BASE}/hours`).send({ rules: [] }),
      request(app).get(`${BASE}/services`),
      request(app).get(`${BASE}/slots?date=${day}&serviceId=${fadeId}`),
      request(app)
        .post(`${BASE}/time-off`)
        .send({ when: { kind: "day", date: day } }),
      request(app)
        .post(`${BASE}/appointments`)
        .send({ serviceId: fadeId, startsAt: at(3, 10).toISOString(), firstName: "X", operationId: opId() }),
    ];
    for (const call of calls) {
      const res = await call.set("Cookie", seatlessCookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "no_chair" });
    }
    // And the write that was refused wrote nothing.
    expect(await prisma.availabilityRule.count({ where: { shopId, staffId: dev } })).toBe(7);
    expect(await prisma.appointment.count({ where: { shopId, firstName: "X" } })).toBe(0);
  });

  it("the dashboard's own routes stay closed to a team member", async () => {
    const res = await request(app)
      .get(`/api/booking/staff/${marcus}/availability`)
      .set("Cookie", devCookie);
    expect(res.status).toBe(403);
  });
});

describe("the day", () => {
  it("🔴 holds this person's bookings only, and no query param can widen it", async () => {
    const mine = await seed(dev, at(3, 9), "Mine");
    const theirs = await seed(marcus, at(3, 10), "NotMine");

    const res = await asDev.get(`/day?date=${dayKey(at(3, 0))}`);
    expect(res.status).toBe(200);
    const ids = res.body.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(res.body.chair).toEqual({ id: dev, name: "Dev" });
    expect(res.body.canBook).toBe(true);

    // Asking nicely for somebody else's is refused outright, not ignored.
    const asked = await asDev.get(`/day?date=${dayKey(at(3, 0))}&staffId=${marcus}`);
    expect(asked.status).toBe(400);
  });

  it("a row says whether it can still be changed, and carries no payment facts", async () => {
    const upcoming = await seed(dev, at(4, 9), "Later");
    const done = await seed(dev, at(4, 11), "Done", { status: "COMPLETED" });

    const res = await asDev.get(`/day?date=${dayKey(at(4, 0))}`);
    const byId = new Map<string, Record<string, unknown>>(
      res.body.rows.map((r: { id: string }) => [r.id, r]),
    );
    expect(byId.get(upcoming.id)!.canChange).toBe(true);
    expect(byId.get(done.id)!.canChange).toBe(false);
    for (const row of byId.values()) {
      for (const key of Object.keys(row)) {
        expect(key).not.toMatch(/paid|payment|tip|refund|deposit|stripe|phone|email|clientId/i);
      }
    }
  });

  it("lists own time off, marking a block that was set for several people", async () => {
    const own = await seedBlock(dev, at(5, 12), 1);
    const group = `grp_${randomToken(8)}`;
    const shared = await seedBlock(dev, at(5, 15), 1, group);
    const colleague = await seedBlock(marcus, at(5, 15), 1, group);
    const colleagueOnly = await seedBlock(marcus, at(5, 9), 1);

    const res = await asDev.get(`/day?date=${dayKey(at(5, 0))}`);
    const byId = new Map<string, { shared: boolean }>(
      res.body.blocks.map((b: { id: string; shared: boolean }) => [b.id, b]),
    );
    expect(byId.get(own.id)!.shared).toBe(false);
    expect(byId.get(shared.id)!.shared).toBe(true);
    expect(byId.has(colleague.id)).toBe(false);
    expect(byId.has(colleagueOnly.id)).toBe(false);
  });

  it("refuses a date that is not a real day", async () => {
    expect((await asDev.get("/day?date=2026-02-31")).status).toBe(400);
    expect((await asDev.get("/day?date=tomorrow")).status).toBe(400);
    expect((await asDev.get("/day?date=2001-01-01")).status).toBe(400);
  });
});

describe("own hours", () => {
  it("reads this person's week", async () => {
    const res = await asDev.get("/hours");
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(7);
    expect(res.body.timezone).toBe("UTC");
  });

  it("🔴 a save replaces this person's week and nobody else's", async () => {
    const before = await prisma.availabilityRule.findMany({
      where: { shopId, staffId: marcus },
      orderBy: { weekday: "asc" },
    });
    const week = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startMin: 8 * 60,
      endMin: 20 * 60,
    }));

    // A staff id riding along is refused, and nothing is written.
    const smuggled = await asDev.put("/hours", { rules: [], staffId: marcus });
    expect(smuggled.status).toBe(400);
    expect(await prisma.availabilityRule.count({ where: { shopId, staffId: marcus } })).toBe(7);
    expect(await prisma.availabilityRule.count({ where: { shopId, staffId: dev } })).toBe(7);

    // A real save: Mondays off, a standing lunch on Tuesdays.
    const res = await asDev.put("/hours", {
      rules: week.filter((r) => r.weekday !== 1),
      recurringBlocks: [{ weekday: 2, startMin: 12 * 60, endMin: 13 * 60, reason: "Lunch" }],
    });
    expect(res.status).toBe(200);
    expect(await prisma.availabilityRule.count({ where: { shopId, staffId: dev } })).toBe(6);
    expect(await prisma.recurringBlock.count({ where: { shopId, staffId: dev } })).toBe(1);

    const after = await prisma.availabilityRule.findMany({
      where: { shopId, staffId: marcus },
      orderBy: { weekday: "asc" },
    });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(await prisma.recurringBlock.count({ where: { shopId, staffId: marcus } })).toBe(0);

    // Back to the full week for the tests below.
    expect((await asDev.put("/hours", { rules: week })).status).toBe(200);
  });
});

describe("own time off", () => {
  it("🔴 lands on this person's calendar only, whatever the body says", async () => {
    const day = dayKey(at(6, 0));

    const smuggled = await asDev.post("/time-off", {
      when: { kind: "day", date: day },
      staffIds: [marcus],
    });
    expect(smuggled.status).toBe(400);
    const narrowed = await asDev.post("/time-off", {
      when: { kind: "day", date: day },
      serviceIds: [fadeId],
    });
    expect(narrowed.status).toBe(400);

    const res = await asDev.post("/time-off", {
      when: { kind: "day", date: day, fromMin: 13 * 60, toMin: 14 * 60 },
      reason: "Dentist",
    });
    expect(res.status).toBe(201);

    const rows = await prisma.availabilityException.findMany({
      where: { shopId, reason: "Dentist" },
      select: { staffId: true, isBlock: true },
    });
    expect(rows).toEqual([{ staffId: dev, isBlock: true }]);
    expect(
      await prisma.availabilityException.count({
        where: { shopId, staffId: marcus, startsAt: { gte: at(6, 0), lt: at(7, 0) } },
      }),
    ).toBe(0);
  });

  it("a block over one of their own bookings must be confirmed first", async () => {
    await seed(dev, at(7, 10), "InTheWay");
    const body = { when: { kind: "day", date: dayKey(at(7, 0)) }, reason: "Day off" };
    const first = await asDev.post("/time-off", body);
    expect(first.status).toBe(409);
    expect(first.body.error).toBe("appointments_overlap");
    expect(await prisma.availabilityException.count({ where: { shopId, reason: "Day off" } })).toBe(0);

    const second = await asDev.post("/time-off", { ...body, confirmation: first.body.confirmation });
    expect(second.status).toBe(201);
    // The booking stays exactly where it was.
    expect(
      await prisma.appointment.count({ where: { shopId, firstName: "InTheWay", status: "BOOKED" } }),
    ).toBe(1);
  });

  it("🔴 cannot remove a colleague's block", async () => {
    const theirs = await seedBlock(marcus, at(8, 9), 2);
    const res = await asDev.del(`/time-off/${theirs.id}`);
    expect(res.status).toBe(404);
    expect(await prisma.availabilityException.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("🔴 cannot remove a block that was set for several people at once", async () => {
    const group = `grp_${randomToken(8)}`;
    const mine = await seedBlock(dev, at(8, 15), 2, group);
    const theirs = await seedBlock(marcus, at(8, 15), 2, group);

    const res = await asDev.del(`/time-off/${mine.id}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "shop_block" });
    expect(await prisma.availabilityException.count({ where: { id: { in: [mine.id, theirs.id] } } })).toBe(2);
  });

  it("removes one of their own, and only that one", async () => {
    const group = `grp_${randomToken(8)}`;
    // A repeating block of their own: two rows, one group, both theirs.
    const first = await seedBlock(dev, at(9, 9), 1, group);
    const second = await seedBlock(dev, at(10, 9), 1, group);

    const res = await asDev.del(`/time-off/${first.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.availabilityException.count({ where: { id: first.id } })).toBe(0);
    expect(await prisma.availabilityException.count({ where: { id: second.id } })).toBe(1);
  });
});

describe("what they can book, and when", () => {
  it("lists only the services this person offers", async () => {
    const res = await asDev.get("/services");
    expect(res.status).toBe(200);
    expect(res.body.services.map((s: { id: string }) => s.id)).toEqual([fadeId]);
  });

  it("🔴 open times are for their own calendar and their own services", async () => {
    const day = dayKey(at(11, 0));
    await seed(dev, at(11, 10), "Taken");
    await seed(marcus, at(11, 11), "ColleagueTaken");

    const res = await asDev.get(`/slots?date=${day}&serviceId=${fadeId}`);
    expect(res.status).toBe(200);
    const starts: string[] = res.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(starts).not.toContain(at(11, 10).toISOString()); // their own booking blocks it
    expect(starts).toContain(at(11, 11).toISOString()); // a colleague's does not

    expect((await asDev.get(`/slots?date=${day}&serviceId=${colourId}`)).status).toBe(404);
    expect((await asDev.get(`/slots?date=${day}&serviceId=${fadeId}&staffId=${marcus}`)).status).toBe(400);
    expect((await asDev.get(`/slots?date=${day}`)).status).toBe(400);
  });

  it("🔴 will not list times for moving a colleague's booking", async () => {
    const theirs = await seed(marcus, at(11, 14), "TheirsToMove");
    const mine = await seed(dev, at(11, 15), "MineToMove");
    const day = dayKey(at(11, 0));

    expect((await asDev.get(`/slots?date=${day}&appointmentId=${theirs.id}`)).status).toBe(404);
    const res = await asDev.get(`/slots?date=${day}&appointmentId=${mine.id}`);
    expect(res.status).toBe(200);
    // Its own place counts as open: moving it there is "no change", not a clash.
    expect(res.body.slots.map((s: { startsAt: string }) => s.startsAt)).toContain(at(11, 15).toISOString());
  });
});

describe("booking a client", () => {
  it("books a new client by name, on this person's calendar", async () => {
    const res = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(12, 9).toISOString(),
      firstName: "Walkup",
      lastName: "Newman",
      operationId: opId(),
    });
    expect(res.status).toBe(201);
    // 🔴 The answer is an allow-list: nothing of the dashboard's answer leaks.
    expect(Object.keys(res.body).sort()).toEqual(["id", "ok"]);

    const row = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    expect(row).toMatchObject({ staffId: dev, serviceId: fadeId, status: "BOOKED", firstName: "Walkup" });
    expect(row!.startsAt.toISOString()).toBe(at(12, 9).toISOString());
  });

  it("🔴 refuses every field that is not a team member's to send, and writes nothing", async () => {
    const base = {
      serviceId: fadeId,
      startsAt: at(12, 10).toISOString(),
      firstName: "Smuggler",
      operationId: opId(),
    };
    const extras: Record<string, unknown>[] = [
      { staffId: marcus },
      { customTime: true },
      { price: 1 },
      { overlapConfirmation: "x" },
      { externalBlockConfirmation: "x" },
      { offerCode: "FREE" },
      { targetedSlotId: "x" },
      { recurrence: { everyWeeks: 1, count: 4 } },
    ];
    for (const extra of extras) {
      const res = await asDev.post("/appointments", { ...base, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Smuggler" } })).toBe(0);
  });

  it("refuses a time outside their hours, a time already taken and a time they blocked", async () => {
    const outside = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(12, 22).toISOString(),
      firstName: "TooLate",
      operationId: opId(),
    });
    expect(outside.status).toBe(400);
    expect(outside.body).toEqual({ error: "invalid_slot" });

    await seed(dev, at(12, 11), "AlreadyThere");
    const taken = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(12, 11).toISOString(),
      firstName: "Clash",
      operationId: opId(),
    });
    expect(taken.status).toBeGreaterThanOrEqual(400);
    expect(taken.status).toBeLessThan(500);
    expect(Object.keys(taken.body)).toEqual(["error"]);

    await seedBlock(dev, at(12, 14), 1);
    const blocked = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(12, 14).toISOString(),
      firstName: "OverBlock",
      operationId: opId(),
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(blocked.status).toBeLessThan(500);
    expect(Object.keys(blocked.body)).toEqual(["error"]);

    expect(
      await prisma.appointment.count({
        where: { shopId, firstName: { in: ["TooLate", "Clash", "OverBlock"] } },
      }),
    ).toBe(0);
  });

  it("refuses a service this person does not offer", async () => {
    const res = await asDev.post("/appointments", {
      serviceId: colourId,
      startsAt: at(12, 16).toISOString(),
      firstName: "WrongService",
      operationId: opId(),
    });
    expect(res.status).toBe(400);
    expect(await prisma.appointment.count({ where: { shopId, firstName: "WrongService" } })).toBe(0);
  });

  it("🔴 books one of their own clients, and never a colleague's", async () => {
    const mine = await prisma.client.create({
      data: { shopId, acuityClientKey: `k-${randomToken(8)}`, magicToken: randomToken(24), firstName: "Regular" },
    });
    const theirs = await prisma.client.create({
      data: { shopId, acuityClientKey: `k-${randomToken(8)}`, magicToken: randomToken(24), firstName: "MarcusRegular" },
    });
    await seed(dev, at(-7, 9), "Regular", { status: "COMPLETED", clientId: mine.id });
    await seed(marcus, at(-7, 9), "MarcusRegular", { status: "COMPLETED", clientId: theirs.id });

    const refused = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(13, 9).toISOString(),
      clientId: theirs.id,
      operationId: opId(),
    });
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: "client_not_found" });
    expect(await prisma.appointment.count({ where: { shopId, clientId: theirs.id } })).toBe(1);

    const ok = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(13, 9).toISOString(),
      clientId: mine.id,
      operationId: opId(),
    });
    expect(ok.status).toBe(201);
    const row = await prisma.appointment.findUnique({ where: { id: ok.body.id } });
    expect(row).toMatchObject({ staffId: dev, clientId: mine.id });

    // A client and a name together is neither.
    const both = await asDev.post("/appointments", {
      serviceId: fadeId,
      startsAt: at(13, 10).toISOString(),
      clientId: mine.id,
      firstName: "Also",
      operationId: opId(),
    });
    expect(both.status).toBe(400);
  });

  it("a retry of one submission is one booking", async () => {
    const body = {
      serviceId: fadeId,
      startsAt: at(13, 12).toISOString(),
      firstName: "Retry",
      operationId: opId(),
    };
    const first = await asDev.post("/appointments", body);
    expect(first.status).toBe(201);
    const again = await asDev.post("/appointments", body);
    expect([200, 201]).toContain(again.status);
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Retry" } })).toBe(1);
  });

  it("🔴 a team member and a customer racing for one time: exactly one gets it", async () => {
    const start = at(14, 9);
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${dev}`,
      [
        async () =>
          asDev.post("/appointments", {
            serviceId: fadeId,
            startsAt: start.toISOString(),
            firstName: "FromTheChair",
            operationId: opId(),
          }),
        async () =>
          request(app)
            .post(`/api/book/${slug}`)
            .send({
              staffId: dev,
              serviceId: fadeId,
              startsAt: start.toISOString(),
              firstName: "FromTheWeb",
              lastName: "Customer",
              email: "fromtheweb@example.com",
            }),
      ],
      600,
    );
    // Both were really waiting on the same lock; neither slipped past it.
    expect(settledEarly).toBe(0);

    const responses = winners(results);
    expect(responses).toHaveLength(2);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
    expect(
      await prisma.appointment.count({
        where: { shopId, staffId: dev, startsAt: start, status: { in: ["BOOKED", "PENDING"] } },
      }),
    ).toBe(1);
  });
});

describe("moving a booking", () => {
  it("🔴 cannot move a colleague's booking", async () => {
    const theirs = await seed(marcus, at(15, 9), "TheirsStays");
    const res = await asDev.post(`/appointments/${theirs.id}/move`, { startsAt: at(15, 12).toISOString() });
    expect(res.status).toBe(404);
    const row = await prisma.appointment.findUnique({ where: { id: theirs.id } });
    expect(row!.startsAt.toISOString()).toBe(at(15, 9).toISOString());
    expect(row!.staffId).toBe(marcus);
  });

  it("moves their own to an open time, and nowhere else", async () => {
    const mine = await seed(dev, at(15, 10), "MineMoves");

    const smuggled = await asDev.post(`/appointments/${mine.id}/move`, {
      startsAt: at(15, 13).toISOString(),
      staffId: marcus,
    });
    expect(smuggled.status).toBe(400);

    const outside = await asDev.post(`/appointments/${mine.id}/move`, { startsAt: at(15, 23).toISOString() });
    expect(outside.status).toBeGreaterThanOrEqual(400);
    expect(outside.status).toBeLessThan(500);

    const res = await asDev.post(`/appointments/${mine.id}/move`, { startsAt: at(15, 13).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const row = await prisma.appointment.findUnique({ where: { id: mine.id } });
    expect(row!.startsAt.toISOString()).toBe(at(15, 13).toISOString());
    expect(row!.staffId).toBe(dev);
  });
});

describe("cancelling a booking", () => {
  it("🔴 cannot cancel a colleague's booking", async () => {
    const theirs = await seed(marcus, at(16, 9), "TheirsKept");
    const res = await asDev.post(`/appointments/${theirs.id}/cancel`, {});
    expect(res.status).toBe(404);
    expect((await prisma.appointment.findUnique({ where: { id: theirs.id } }))!.status).toBe("BOOKED");
  });

  it("🔴 cannot cancel a visit that is finished or already past", async () => {
    const done = await seed(dev, at(-1, 9), "Finished", { status: "COMPLETED" });
    const past = await seed(dev, at(-1, 11), "PastButOpen");
    for (const appt of [done, past]) {
      const res = await asDev.post(`/appointments/${appt.id}/cancel`, {});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "not_cancellable" });
    }
    expect((await prisma.appointment.findUnique({ where: { id: done.id } }))!.status).toBe("COMPLETED");
    expect((await prisma.appointment.findUnique({ where: { id: past.id } }))!.status).toBe("BOOKED");
  });

  it("cancels their own upcoming booking, and cannot record a fee with it", async () => {
    const mine = await seed(dev, at(16, 10), "MineCancelled");

    const withFee = await asDev.post(`/appointments/${mine.id}/cancel`, { lateCancelFee: true });
    expect(withFee.status).toBe(400);
    expect((await prisma.appointment.findUnique({ where: { id: mine.id } }))!.status).toBe("BOOKED");

    const res = await asDev.post(`/appointments/${mine.id}/cancel`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await prisma.appointment.findUnique({ where: { id: mine.id } }))!.status).toBe("CANCELED");
  });
});
