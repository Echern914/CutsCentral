import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/insights/stats - the numbers-first strip at the top of Insights.
 *
 * What is load-bearing here:
 *   - SHOP-LOCAL periods. A cut at 11:30pm New York time is 03:30 UTC the next
 *     day; it belongs on the barber's own day, not on UTC's.
 *   - Synced (Acuity/Square) visits count, exactly as everywhere on Insights.
 *   - The window is BOUNDED by the grain; a request cannot widen it.
 *   - The suggested goal is the recent average plus a capped stretch, and a
 *     shop with no history is given none.
 *
 * 🔴 TIME IS FROZEN at a fixed PAST instant, Wednesday 2026-06-17 noon in New
 * York, and every fixture is an absolute instant around it - nothing here can
 * go red on a later calendar day.
 */
const FROZEN_NOW = new Date("2026-06-17T16:00:00.000Z"); // Wed 12:00 EDT
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let emptyCookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientA: string; // first ever booking is in the window -> new
let clientB: string; // has history from January -> returning

type Metric = { key: string; locked: boolean; values: (number | null)[] };
type Stats = {
  grain: string;
  scope: string;
  periods: { key: string; label: string; fullLabel: string }[];
  metrics: Metric[];
  suggestions: {
    metric: string;
    period: string;
    target: number;
    average: number;
    periodsAveraged: number;
    best: number;
  }[];
  levers: { rewards: boolean; rebookPush: boolean; autoFill: boolean } | null;
};

async function signup(): Promise<string> {
  const email = `stats-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Stats Tester", smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const c = (res.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", c).send({ name: "Stats Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ bookingMode: "native", timezone: "America/New_York" });
  return c;
}

async function getStats(c: string, query = ""): Promise<Stats> {
  const res = await request(app).get(`/api/insights/stats${query}`).set("Cookie", c);
  expect(res.status).toBe(200);
  return res.body as Stats;
}

const series = (s: Stats, key: string) => s.metrics.find((m) => m.key === key)!.values;
const indexOf = (s: Stats, key: string) => s.periods.findIndex((p) => p.key === key);

async function appointment(
  startsAt: string,
  clientId: string | null,
  price: number | null,
  status: "BOOKED" | "COMPLETED" | "NO_SHOW" = "COMPLETED",
) {
  const start = new Date(startsAt);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Reg",
      status,
      startsAt: start,
      endsAt: new Date(start.getTime() + 45 * 60_000),
      priceAtBooking: price,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

/** An Acuity-style synced visit with no native appointment behind it. */
async function syncedVisit(scheduledAt: string, clientId: string, price: number) {
  const at = new Date(scheduledAt);
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `stats-${randomToken(8)}`,
      status: "COMPLETED",
      scheduledAt: at,
      endAt: new Date(at.getTime() + 30 * 60_000),
      completedAt: at,
      serviceName: "Haircut",
      price,
    },
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  cookie = await signup();
  emptyCookie = await signup();
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id as string;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 45, price: 40 },
      select: { id: true },
    })
  ).id;
  const mk = async (key: string) =>
    (
      await prisma.client.create({
        data: { shopId, acuityClientKey: `stats-${key}-${randomToken(6)}`, magicToken: randomToken(), firstName: key },
        select: { id: true },
      })
    ).id;
  clientA = await mk("A");
  clientB = await mk("B");

  // 🔴 The timezone case: Monday Jun 15, 11:30pm in New York = Tue 03:30 UTC.
  const late = await appointment("2026-06-16T03:30:00.000Z", clientA, 40);
  // An online tip left on that visit ($8). Not revenue - its own card.
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId: late.id,
      purpose: "tip",
      stripePaymentIntentId: `pi_stats_${randomToken(10)}`,
      stripeConnectAccountId: "acct_stats_test",
      mode: "ahead",
      amount: 800,
      status: "succeeded",
    },
  });
  // Tuesday Jun 16, 10am New York: a synced Acuity visit ($60) and a no-show.
  await syncedVisit("2026-06-16T14:00:00.000Z", clientB, 60);
  await appointment("2026-06-16T18:00:00.000Z", clientB, 40, "NO_SHOW");
  // Later today: has not happened, must not count.
  await appointment("2026-06-17T19:00:00.000Z", clientA, 40, "BOOKED");
  // Client B's history began in January -> returning, not new.
  await syncedVisit("2026-01-10T17:00:00.000Z", clientB, 30);

  // Weekly history for the suggestion: one $500 visit each of the four
  // complete weeks before this one, and a $900 week before those.
  for (const at of [
    "2026-05-13T16:00:00.000Z", // week of May 11: $900
    "2026-05-20T16:00:00.000Z",
    "2026-05-27T16:00:00.000Z",
    "2026-06-03T16:00:00.000Z",
    "2026-06-10T16:00:00.000Z",
  ]) {
    await syncedVisit(at, clientB, at.startsWith("2026-05-13") ? 900 : 500);
  }
});

afterAll(async () => {
  vi.useRealTimers();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("GET /api/insights/stats", () => {
  it("day grain: 14 shop-local days ending today, an 11:30pm cut on its own day", async () => {
    const s = await getStats(cookie, "?grain=day");
    expect(s.grain).toBe("day");
    expect(s.scope).toBe("full");
    expect(s.periods).toHaveLength(14);
    expect(s.periods.at(-1)!.key).toBe("2026-06-17");

    const mon = indexOf(s, "2026-06-15");
    const tue = indexOf(s, "2026-06-16");
    expect(mon).toBe(11);
    // The late cut is Monday's, not Tuesday's (which is where UTC puts it).
    expect(series(s, "bookings")[mon]).toBe(1);
    expect(series(s, "revenue")[mon]).toBe(4000);
    expect(series(s, "hoursBooked")[mon]).toBe(45);
    expect(series(s, "avgTicket")[mon]).toBe(4000);
    expect(series(s, "tips")[mon]).toBe(800);
    expect(series(s, "newClients")[mon]).toBe(1);

    // Tuesday: the synced visit counts; the no-show is its own number and
    // earns nothing, but held the chair for 45 minutes.
    expect(series(s, "bookings")[tue]).toBe(1);
    expect(series(s, "noShows")[tue]).toBe(1);
    expect(series(s, "revenue")[tue]).toBe(6000);
    expect(series(s, "hoursBooked")[tue]).toBe(30 + 45);
    expect(series(s, "newClients")[tue]).toBe(0);

    // Today's later booking has not happened yet.
    expect(series(s, "bookings")[13]).toBe(0);
    // A day with no priced visit has no average, not a $0 one.
    expect(series(s, "avgTicket")[13]).toBeNull();
  });

  it("week and month grains bucket by Monday and by the 1st", async () => {
    const w = await getStats(cookie, "?grain=week");
    expect(w.periods).toHaveLength(10);
    expect(w.periods.at(-1)!.key).toBe("2026-06-15");
    expect(series(w, "bookings").at(-1)).toBe(2);
    expect(series(w, "revenue").at(-1)).toBe(10_000);
    expect(series(w, "revenue").at(-2)).toBe(50_000);

    const m = await getStats(cookie, "?grain=month");
    expect(m.periods).toHaveLength(12);
    expect(m.periods.at(-1)!.key).toBe("2026-06");
    expect(series(m, "revenue")[indexOf(m, "2026-01")]).toBe(3000);
    expect(series(m, "revenue")[indexOf(m, "2026-05")]).toBe(190_000);
  });

  it("compares the period in progress with the previous one UP TO THE SAME POINT", async () => {
    const prev = (s: Stats, key: string) =>
      (s.metrics.find((m) => m.key === key) as Metric & { previousToDate: number | null }).previousToDate;
    // Day: yesterday (Tue) until noon New York - the 10am synced visit is in,
    // the 2pm no-show is not yet.
    const d = await getStats(cookie, "?grain=day");
    expect(prev(d, "bookings")).toBe(1);
    expect(prev(d, "revenue")).toBe(6000);
    expect(prev(d, "noShows")).toBe(0);
    expect(series(d, "noShows")[12]).toBe(1); // the whole of Tuesday still shows it
    // Month: May until the 17th at noon - the May 13 visit only, not the whole
    // $1,900 month the May bar shows.
    const m = await getStats(cookie, "?grain=month");
    expect(prev(m, "revenue")).toBe(90_000);
    expect(series(m, "revenue").at(-2)).toBe(190_000);
    // Week: last Wednesday noon is exactly the same point as now - in.
    const w = await getStats(cookie, "?grain=week");
    expect(prev(w, "revenue")).toBe(50_000);
  });

  it("keeps the window bounded: the grain picks the count, a request cannot", async () => {
    const s = await getStats(cookie, "?grain=day&count=500&from=2020-01-01");
    expect(s.periods).toHaveLength(14);
    const bogus = await getStats(cookie, "?grain=decade");
    expect(bogus.grain).toBe("week");
    expect(bogus.periods).toHaveLength(10);
    // January's visit is outside 14 days and never leaks into the series.
    const total = series(s, "bookings").reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(3); // Jun 10, Jun 15 (late), Jun 16 (synced)
  });

  it("suggests next week's goal: the last 4 weeks' average plus a capped stretch", async () => {
    const s = await getStats(cookie, "?grain=week");
    const rev = s.suggestions.find((x) => x.metric === "revenue" && x.period === "week")!;
    // Average $500; the $900 week is far above, so the full 15% cap: $575,
    // rounded to $10 without crossing the cap -> $570. Never the $900.
    expect(rev).toMatchObject({ average: 500, periodsAveraged: 4, best: 900, target: 570 });
    const visits = s.suggestions.find((x) => x.metric === "visits" && x.period === "week")!;
    expect(visits.target).toBe(2);
    expect(s.levers).toEqual({ rewards: false, rebookPush: true, autoFill: false });
  });

  it("gives a shop with no history no suggestion, and no tips card it never offered", async () => {
    const s = await getStats(emptyCookie, "?grain=week");
    expect(s.suggestions).toEqual([]);
    expect(s.metrics.map((m) => m.key)).not.toContain("tips");
    expect(series(s, "bookings").every((v) => v === 0)).toBe(true);
  });
});
