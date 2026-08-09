import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Insights quota goals: PUT/GET/DELETE /api/insights/goal + the progress math.
 *
 * A shop holds ONE target per (metric, period) - "$4,000 a month" and "60 cuts a
 * week" are different goals and each keeps its own number. Setting one must
 * never overwrite another; the old schema had a unique on shopId, so switching
 * the toggle in the UI silently wiped the previous target.
 *
 * Progress derives from the same chair events the rest of Insights counts:
 * revenue goals sum the price (unpriced bookings contribute $0 but still count
 * as cuts), cut goals count bookings. Pace = straight-line target across the
 * shop-local period.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let shopId: string;
let clientId: string;
const emails: string[] = [];

type Goal = {
  metric: "revenue" | "visits";
  period: "week" | "month";
  target: number | null;
  progress: {
    actual: number;
    totalDays: number;
    elapsedDays: number;
    daysLeft: number;
    paceTarget: number;
    delta: number;
    pct: number;
    series: { day: number; cumulative: number | null }[];
  } | null;
};

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Goal Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function getGoals(): Promise<Goal[]> {
  const res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.goals as Goal[];
}

/** The one slot for a (metric, period) pair. */
async function slot(metric: string, period: string): Promise<Goal> {
  const goals = await getGoals();
  const found = goals.find((g) => g.metric === metric && g.period === period);
  expect(found).toBeDefined();
  return found!;
}

const putGoal = (body: Record<string, unknown>) =>
  request(app).put("/api/insights/goal").set("Cookie", cookie).send(body);

const deleteGoal = (query: Record<string, string> = {}) =>
  request(app).delete("/api/insights/goal").query(query).set("Cookie", cookie);

/** A COMPLETED visit `hoursAgo` hours back (safely inside week AND month). */
async function seedVisit(price: number | null, hoursAgo = 1) {
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `goal-${randomToken(6)}`,
      status: "COMPLETED",
      scheduledAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      endAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000 + 30 * 60 * 1000),
      completedAt: new Date(),
      price,
    },
  });
}

beforeAll(async () => {
  const email = `goal-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Goal Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC" });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id as string;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `goal-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Regular",
    },
    select: { id: true },
  });
  clientId = client.id;
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

describe("insights quota goals", () => {
  it("lists all four slots, unset, before anything is saved", async () => {
    const goals = await getGoals();
    expect(goals).toHaveLength(4);
    expect(goals.map((g) => `${g.metric}:${g.period}`).sort()).toEqual([
      "revenue:month",
      "revenue:week",
      "visits:month",
      "visits:week",
    ]);
    for (const g of goals) {
      expect(g.target).toBeNull();
      expect(g.progress).toBeNull();
    }
  });

  it("rejects a bad target", async () => {
    expect((await putGoal({ metric: "revenue", period: "month", target: 0 })).status).toBe(400);
    expect((await putGoal({ metric: "cuts", period: "month", target: 10 })).status).toBe(400);
  });

  it("revenue goal: actual sums booking prices; pace + series are sane", async () => {
    await seedVisit(40);
    await seedVisit(35);
    await seedVisit(null); // unpriced: counts as a cut, adds $0
    await prisma.visit.create({
      // CANCELED never counts.
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `goal-${randomToken(6)}`,
        status: "CANCELED",
        scheduledAt: new Date(),
        canceledAt: new Date(),
        price: 500,
      },
    });

    expect((await putGoal({ metric: "revenue", period: "month", target: 4000 })).status).toBe(200);
    const g = await slot("revenue", "month");
    expect(g.target).toBe(4000);
    const p = g.progress!;
    expect(p.actual).toBe(75);
    expect(p.totalDays).toBeGreaterThanOrEqual(28);
    expect(p.elapsedDays).toBeGreaterThanOrEqual(1);
    expect(p.elapsedDays).toBeLessThanOrEqual(p.totalDays);
    expect(p.daysLeft).toBe(p.totalDays - p.elapsedDays);
    // Straight-line pace for the elapsed fraction of the month.
    expect(p.paceTarget).toBe(Math.round((4000 * p.elapsedDays) / p.totalDays));
    expect(p.delta).toBe(p.actual - p.paceTarget);
    expect(p.pct).toBeCloseTo(75 / 4000, 5);
    // Series: one point per period day; cumulative reaches `actual` at today
    // and is null for future days.
    expect(p.series).toHaveLength(p.totalDays);
    expect(p.series[p.elapsedDays - 1]!.cumulative).toBe(75);
    if (p.elapsedDays < p.totalDays) {
      expect(p.series[p.elapsedDays]!.cumulative).toBeNull();
    }
  });

  it("cut-count goal counts every booking, priced or not", async () => {
    expect((await putGoal({ metric: "visits", period: "week", target: 60 })).status).toBe(200);
    const g = await slot("visits", "week");
    expect(g.target).toBe(60);
    expect(g.progress!.actual).toBe(3); // the three non-canceled seeds
    expect(g.progress!.totalDays).toBe(7);
  });

  it("saves each metric AND period separately - one never wipes another", async () => {
    // The two above are still set, and both remember their own number.
    expect((await slot("revenue", "month")).target).toBe(4000);
    expect((await slot("visits", "week")).target).toBe(60);

    // Fill the other two slots; all four then coexist with distinct targets.
    expect((await putGoal({ metric: "revenue", period: "week", target: 900 })).status).toBe(200);
    expect((await putGoal({ metric: "visits", period: "month", target: 200 })).status).toBe(200);

    const goals = await getGoals();
    const targets = Object.fromEntries(
      goals.map((g) => [`${g.metric}:${g.period}`, g.target]),
    );
    expect(targets).toEqual({
      "revenue:month": 4000,
      "revenue:week": 900,
      "visits:month": 200,
      "visits:week": 60,
    });
    // Each carries its OWN progress against its OWN target.
    expect((await slot("revenue", "week")).progress!.pct).toBeCloseTo(75 / 900, 5);
    expect((await slot("visits", "month")).progress!.actual).toBe(3);
  });

  it("re-saving one slot updates only that slot", async () => {
    expect((await putGoal({ metric: "revenue", period: "month", target: 5000 })).status).toBe(200);
    expect((await slot("revenue", "month")).target).toBe(5000);
    expect((await slot("visits", "week")).target).toBe(60);
    expect((await slot("revenue", "week")).target).toBe(900);
  });

  it("DELETE clears ONE goal and leaves the rest (idempotent)", async () => {
    expect((await deleteGoal({ metric: "revenue", period: "month" })).status).toBe(200);
    expect((await slot("revenue", "month")).target).toBeNull();
    expect((await slot("revenue", "week")).target).toBe(900);
    expect((await slot("visits", "week")).target).toBe(60);
    // Repeating it is a no-op, not a 404.
    expect((await deleteGoal({ metric: "revenue", period: "month" })).status).toBe(200);
  });

  it("DELETE with no filter clears them all", async () => {
    expect((await deleteGoal()).status).toBe(200);
    for (const g of await getGoals()) {
      expect(g.target).toBeNull();
      expect(g.progress).toBeNull();
    }
  });
});

describe("goal planner: plans, chair-time target, per-service quotas", () => {
  it("round-trips a saved plan on a quota goal; null clears it", async () => {
    const svc = await prisma.service.create({
      data: { shopId, name: "Plan Fade", durationMin: 45, price: 50 },
      select: { id: true },
    });
    const plan = {
      bookedPct: 80,
      services: [{ serviceId: svc.id, priceDelta: 5, extraCuts: 3 }],
    };
    expect(
      (await putGoal({ metric: "revenue", period: "week", target: 1200, plan })).status,
    ).toBe(200);
    let g = (await slot("revenue", "week")) as Goal & { plan?: unknown };
    expect(g.target).toBe(1200);
    expect(g.plan).toEqual(plan);

    // Re-saving the target WITHOUT the plan leaves the plan alone.
    expect((await putGoal({ metric: "revenue", period: "week", target: 1300 })).status).toBe(200);
    g = (await slot("revenue", "week")) as Goal & { plan?: unknown };
    expect(g.target).toBe(1300);
    expect(g.plan).toEqual(plan);

    // Explicit null clears it.
    expect(
      (await putGoal({ metric: "revenue", period: "week", target: 1300, plan: null })).status,
    ).toBe(200);
    g = (await slot("revenue", "week")) as Goal & { plan?: unknown };
    expect(g.plan).toBeNull();
  });

  it("stores the standing chair-time % target and bounds it to 1-100", async () => {
    expect((await putGoal({ metric: "chairTime", period: "overall", target: 75 })).status).toBe(200);
    let res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    expect(res.body.chairTime.target).toBe(75);

    expect((await putGoal({ metric: "chairTime", period: "overall", target: 130 })).status).toBe(400);
    // A chair-time goal is a level, not a weekly quota.
    expect((await putGoal({ metric: "chairTime", period: "week", target: 75 })).status).toBe(400);

    expect((await deleteGoal({ metric: "chairTime" })).status).toBe(200);
    res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    expect(res.body.chairTime.target).toBeNull();
  });

  it("per-service quota: saved, measured against that service's bookings, cleared", async () => {
    const svc = await prisma.service.create({
      data: { shopId, name: "Quota Retwist", durationMin: 60, price: 90 },
      select: { id: true },
    });
    // Two bookings of THIS service this week (native carries the serviceId)...
    const staff = await prisma.staff.create({ data: { shopId, name: "Q" }, select: { id: true } });
    for (let i = 0; i < 2; i++) {
      await prisma.appointment.create({
        data: {
          shopId,
          staffId: staff.id,
          serviceId: svc.id,
          clientId,
          firstName: "Q",
          status: "COMPLETED",
          startsAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
          endsAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000 + 60 * 60 * 1000),
          priceAtBooking: 90,
          manageToken: randomToken(),
        },
      });
    }
    // ...and one SYNCED visit that only carries the service's NAME.
    await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `goal-${randomToken(6)}`,
        status: "COMPLETED",
        scheduledAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        endAt: new Date(Date.now() - 3 * 60 * 60 * 1000 + 60 * 60 * 1000),
        completedAt: new Date(),
        serviceName: "Quota Retwist",
        price: 90,
      },
    });

    expect(
      (await putGoal({ metric: "visits", period: "week", target: 12, serviceId: svc.id })).status,
    ).toBe(200);
    const res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    const sg = (res.body.serviceGoals as {
      serviceId: string;
      name: string;
      target: number;
      actual: number;
      pct: number;
    }[]).find((x) => x.serviceId === svc.id);
    expect(sg).toBeDefined();
    expect(sg!.name).toBe("Quota Retwist");
    expect(sg!.target).toBe(12);
    expect(sg!.actual).toBe(3); // 2 native + 1 name-matched synced
    expect(sg!.pct).toBeCloseTo(3 / 12, 5);

    // A serviceId from another shop's menu (or nowhere) 404s cleanly.
    expect(
      (await putGoal({ metric: "visits", period: "week", target: 5, serviceId: "nope" })).status,
    ).toBe(404);

    expect((await deleteGoal({ serviceId: svc.id })).status).toBe(200);
    const after = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    expect(
      (after.body.serviceGoals as { serviceId: string }[]).some((x) => x.serviceId === svc.id),
    ).toBe(false);
  });

  it("ships the planner payload: per-service run-rates + full-window capacity", async () => {
    // Give the shop a schedule so capacity is non-zero: Mon-Sun 9-5.
    const staff = await prisma.staff.create({ data: { shopId, name: "Cap" }, select: { id: true } });
    for (let wd = 0; wd < 7; wd++) {
      await prisma.availabilityRule.create({
        data: { shopId, staffId: staff.id, weekday: wd, startMin: 9 * 60, endMin: 17 * 60 },
      });
    }
    const res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const planner = res.body.planner as {
      services: { serviceId: string; name: string; price: number | null; durationMin: number; week: { cuts: number }; month: { cuts: number } }[];
      capacity: { week: { openMin: number }; month: { openMin: number } };
    };
    const quota = planner.services.find((s) => s.name === "Quota Retwist");
    expect(quota).toMatchObject({ price: 90, durationMin: 60 });
    expect(quota!.week.cuts).toBe(3);
    // A full week at 8h/day for (at least) one chair. Other staff rows created
    // by earlier tests may add capacity - assert the floor, not the exact sum.
    expect(planner.capacity.week.openMin).toBeGreaterThanOrEqual(7 * 8 * 60);
    expect(planner.capacity.month.openMin).toBeGreaterThan(planner.capacity.week.openMin);
  });

  it("joins a synced service name that differs only by punctuation or case", async () => {
    // The reported symptom: every planner row read "0 / month" while the shop's
    // WHOLE-SHOP revenue was fine. Shop-wide totals need no serviceId; per-service
    // ones join synced events by NAME, and that join was trim+lowercase only - so
    // "Men's Haircut" in Acuity never matched "Mens Haircut" on the menu and the
    // barber's real volume vanished from the planner he was trying to plan with.
    const svc = await prisma.service.create({
      data: { shopId, name: "Mens Haircut", durationMin: 30, price: 50 },
      select: { id: true },
    });
    for (const name of ["Men's Haircut", "MENS  HAIRCUT", "mens haircut"]) {
      await prisma.visit.create({
        data: {
          shopId,
          clientId,
          acuityAppointmentId: `punct-${randomToken(8)}`,
          status: "COMPLETED",
          scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          endAt: new Date(Date.now() - 2 * 60 * 60 * 1000 + 30 * 60 * 1000),
          completedAt: new Date(),
          serviceName: name,
          price: 50,
        },
      });
    }

    const res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    const row = (
      res.body.planner.services as { serviceId: string; week: { cuts: number } }[]
    ).find((s) => s.serviceId === svc.id);
    // All three spellings are the same haircut.
    expect(row!.week.cuts).toBe(3);
  });

  it("refuses to guess when two menu names normalize the same", async () => {
    // "Cut & Beard" and "Cut + Beard" both fold to "cut beard". Picking whichever
    // was defined first would silently credit one service with the other's
    // volume, which is worse than showing nothing - so an ambiguous name joins
    // to neither and only the explicit serviceId counts.
    await prisma.service.create({
      data: { shopId, name: "Cut & Beard", durationMin: 45, price: 70 },
    });
    const b = await prisma.service.create({
      data: { shopId, name: "Cut + Beard", durationMin: 45, price: 70 },
      select: { id: true },
    });
    await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `ambig-${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endAt: new Date(Date.now() - 2 * 60 * 60 * 1000 + 45 * 60 * 1000),
        completedAt: new Date(),
        serviceName: "Cut and Beard",
        price: 70,
      },
    });
    const res = await request(app).get("/api/insights/goal").set("Cookie", cookie);
    const row = (
      res.body.planner.services as { serviceId: string; week: { cuts: number } }[]
    ).find((s) => s.serviceId === b.id);
    expect(row!.week.cuts).toBe(0);
  });
});
