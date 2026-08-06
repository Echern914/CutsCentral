import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber surface: one chair, nothing else.
 *
 * The load-bearing property is ISOLATION - an invited barber must see their own
 * book and be unable to reach anything else, including by asking nicely (a
 * staffId query param) or by hitting a manager route directly. Most of these
 * tests exist to pin that from the outside.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

let ownerCookie: string;
let shopId: string;
let chairA: string; // the barber's chair
let chairB: string; // a colleague's chair
let serviceId: string;
let barberCookie: string;

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

/**
 * A fixed hour of TODAY in the shop's zone (the test shop is UTC).
 *
 * "now + 2h" is not usable for day-scoped assertions: run late enough in the
 * UTC day and it lands on tomorrow, so the endpoint correctly drops it and the
 * test fails for reasons that have nothing to do with the code. The endpoint
 * returns the whole shop day, past hours included, so anchoring to a fixed hour
 * is both deterministic and realistic.
 */
function todayAtUtc(hour: number): Date {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

async function makeAppointment(staffId: string, startsAt: Date, who: string) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: who,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(16),
    },
  });
}

beforeAll(async () => {
  const owner = await signup("bd-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Barber Dash Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC" });

  const a = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Dev" });
  chairA = a.body.id;
  const b = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Marcus" });
  chairB = b.body.id;

  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA, chairB] });
  serviceId = svc.body.id;

  // An invited barber, seated on chair A.
  const barber = await signup("bd-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: barber.userId, role: "BARBER", staffId: chairA },
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

const window = () => ({
  from: hoursFromNow(-36).toISOString(),
  to: hoursFromNow(36).toISOString(),
});

describe("barber home: their own chair", () => {
  it("returns only appointments on the barber's chair", async () => {
    await makeAppointment(chairA, todayAtUtc(9), "Mine");
    await makeAppointment(chairB, todayAtUtc(10), "NotMine");

    const w = window();
    const res = await request(app)
      .get(`/api/barber/home?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`)
      .set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.chair.name).toBe("Dev");
    const names = res.body.today.map((r: { clientName: string }) => r.clientName);
    expect(names).toContain("Mine");
    // The colleague's client must not appear, by name or by count.
    expect(names).not.toContain("NotMine");
  });

  it("ignores a staffId supplied by the client (no reading a colleague's book)", async () => {
    const w = window();
    // The obvious attack: ask for someone else's chair.
    const res = await request(app)
      .get(
        `/api/barber/home?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&staffId=${chairB}`,
      )
      .set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.chair.id).toBe(chairA);
    const names = res.body.today.map((r: { clientName: string }) => r.clientName);
    expect(names).not.toContain("NotMine");
  });

  it("returns only the SHOP's calendar day, not the whole requested window", async () => {
    // The caller can't know the shop's timezone before this response, so it
    // sends a generous +/-36h window - which spans three local days. Everything
    // outside today must be dropped, or "Your day" lists tomorrow afternoon.
    const tomorrow = await makeAppointment(chairA, hoursFromNow(30), "Tomorrow");
    const yesterday = await makeAppointment(chairA, hoursFromNow(-30), "Yesterday");

    const res = await request(app)
      .get(
        `/api/barber/home?from=${encodeURIComponent(hoursFromNow(-36).toISOString())}` +
          `&to=${encodeURIComponent(hoursFromNow(36).toISOString())}`,
      )
      .set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    const names = res.body.today.map((r: { clientName: string }) => r.clientName);
    expect(names).not.toContain("Tomorrow");
    expect(names).not.toContain("Yesterday");

    // Rows are ascending by time within that day.
    const times = res.body.today.map((r: { startsAt: string }) =>
      new Date(r.startsAt).getTime(),
    );
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    await prisma.appointment.deleteMany({
      where: { id: { in: [tomorrow.id, yesterday.id] } },
    });
  });

  it("explains itself when the seat has no chair linked", async () => {
    const seatless = await signup("bd-seatless");
    await prisma.shopMember.create({
      data: { shopId, userId: seatless.userId, role: "BARBER", staffId: null },
    });
    const w = window();
    const res = await request(app)
      .get(`/api/barber/home?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`)
      .set("Cookie", seatless.cookie);
    expect(res.status).toBe(200);
    expect(res.body.chair).toBeNull();
    expect(res.body.today).toEqual([]);
    // A blank day that looks broken is worse than one that says why.
    expect(res.body.reason).toBe("no_chair_linked");
  });

  it("counts only the barber's own completed cuts", async () => {
    // Two hours AGO, not a fixed hour of the UTC day: the counts only sum
    // completed work in [monthAgo, now], so `todayAtUtc(8)` was in the FUTURE
    // whenever the suite ran between 00:00 and 08:00 UTC (i.e. every US
    // evening) and this counted 0.
    const mine = await makeAppointment(chairA, hoursFromNow(-2), "DoneMine");
    const theirs = await makeAppointment(chairB, hoursFromNow(-2), "DoneTheirs");
    await prisma.appointment.updateMany({
      where: { id: { in: [mine.id, theirs.id] } },
      data: { status: "COMPLETED" },
    });

    const w = window();
    const res = await request(app)
      .get(`/api/barber/home?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`)
      .set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    // Exactly one of the two completed cuts is theirs.
    expect(res.body.counts.month).toBe(1);
  });
});

describe("barber isolation: the manager surfaces stay closed", () => {
  const w = () => window();

  it("403s on every manager-gated dashboard route", async () => {
    const routes = [
      "/api/dashboard/stats",
      "/api/dashboard/at-risk",
      "/api/dashboard/activity",
      "/api/dashboard/leaderboard",
      "/api/dashboard/referrals",
      "/api/insights/summary",
      "/api/promotions",
    ];
    for (const route of routes) {
      const res = await request(app).get(route).set("Cookie", barberCookie);
      expect([403, 404], `${route} -> ${res.status}`).toContain(res.status);
      if (res.status === 403) expect(res.body.error).toBe("forbidden_role");
    }
  });

  it("403s on the shop-wide agenda (that's the manager's book)", async () => {
    const q = w();
    const res = await request(app)
      .get(
        `/api/booking/agenda?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`,
      )
      .set("Cookie", barberCookie);
    expect(res.status).toBe(403);
  });

  it("403s on billing and team - money and access control are owner business", async () => {
    for (const route of ["/api/billing", "/api/team"]) {
      const res = await request(app).get(route).set("Cookie", barberCookie);
      expect([403, 404], `${route} -> ${res.status}`).toContain(res.status);
    }
  });

  it("a signed-out request gets 401, not a barber's book", async () => {
    const q = w();
    const res = await request(app).get(
      `/api/barber/home?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`,
    );
    expect(res.status).toBe(401);
  });
});

describe("/api/auth/me carries the seat", () => {
  it("tells the web the role and chair of an invited barber", async () => {
    const res = await request(app).get("/api/auth/me").set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    // Before this, a member owned no shop so activeShopId was null and the web
    // had no way to know it was rendering for an employee.
    expect(res.body.shopRole).toBe("BARBER");
    expect(res.body.staffId).toBe(chairA);
    expect(res.body.activeShopId).toBe(shopId);
    expect(res.body.activeShopName).toBe("Barber Dash Cuts");
  });

  it("still reports the owner as OWNER with no chair", async () => {
    const res = await request(app).get("/api/auth/me").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.shopRole).toBe("OWNER");
    expect(res.body.staffId).toBeNull();
    expect(res.body.activeShopId).toBe(shopId);
  });
});
