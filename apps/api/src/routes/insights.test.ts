import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber insights endpoint: bucketed cuts, the service menu, priced-only avg
 * ticket, new-vs-returning, busiest weekday, loyalty activity.
 *
 * The load-bearing case is that NATIVE bookings count. Insights used to read
 * COMPLETED `Visit` rows only, which a native appointment becomes only once the
 * promotion cron runs - and never at all for a walk-in with no Client, because
 * Visit.clientId is NOT NULL. A native shop therefore saw an empty chart and a
 * half-empty service list. Both systems now feed the same numbers.
 */
const app = createApp();
const email = `ins-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookie: string;
let shopId: string;
let staffId: string;
let fadeId: string; // a service that gets booked natively
let unbookedId: string; // a service nobody books — must still be listed, at 0
let clientA: string; // all visits inside the window -> NEW
let clientB: string; // has an old visit before the window -> RETURNING
let seq = 0;

/** Noon UTC, `daysAgo` days back (shop tz is pinned to UTC below). */
function daysAgoAtNoon(daysAgo: number): Date {
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  when.setUTCHours(12, 0, 0, 0);
  return when;
}

/** An externally-synced (Acuity/Square-like) completed visit. */
async function makeVisit(
  clientId: string,
  daysAgo: number,
  serviceName: string | null,
  price: number | null,
) {
  const when = daysAgoAtNoon(daysAgo);
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `ins-${++seq}`,
      status: "COMPLETED",
      scheduledAt: when,
      endAt: new Date(when.getTime() + 30 * 60_000),
      completedAt: when,
      serviceName,
      price,
    },
  });
}

/** A native booking. `clientId: null` is the walk-in case. */
async function makeAppointment(
  clientId: string | null,
  daysAgo: number,
  price: number | null,
  status: "BOOKED" | "COMPLETED" | "CANCELED" = "BOOKED",
) {
  const when = daysAgoAtNoon(daysAgo);
  when.setUTCHours(14, 0, 0, 0);
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: fadeId,
      clientId,
      firstName: clientId ? "Reg" : "Walk-in",
      status,
      startsAt: when,
      endsAt: new Date(when.getTime() + 45 * 60_000),
      priceAtBooking: price,
      manageToken: randomToken(),
      ...(status === "CANCELED" ? { canceledAt: new Date() } : {}),
    },
  });
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Insights Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Insights Cuts",
      bookingUrl: "https://ins.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  // Assertions below bucket by shop-local days; pin UTC so they're stable
  // regardless of where/when the suite runs.
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });

  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const fade = await prisma.service.create({
    data: { shopId, name: "Fade", durationMin: 45, price: 45 },
    select: { id: true },
  });
  fadeId = fade.id;
  const unbooked = await prisma.service.create({
    data: { shopId, name: "Hot Towel Shave", durationMin: 30, price: 25 },
    select: { id: true },
  });
  unbookedId = unbooked.id;

  for (const key of ["a", "b"]) {
    const created = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: key.toUpperCase() });
    expect(created.status).toBe(201);
    if (key === "a") clientA = created.body.id;
    else clientB = created.body.id;
  }

  // Synced visits inside the default (30-day) window:
  await makeVisit(clientA, 2, "Haircut", 40);
  await makeVisit(clientA, 3, "Haircut", 40);
  await makeVisit(clientA, 9, "Loc Retwist", 90);
  await makeVisit(clientB, 4, null, null); // unpriced + no service (Square-like)
  // clientB's history starts BEFORE the window -> returning.
  await makeVisit(clientB, 94, "Haircut", 35);

  // Native bookings inside the window. NONE of these has been promoted to a
  // Visit, which is exactly the state the old endpoint could not see.
  await makeAppointment(clientA, 5, 45); // BOOKED, past — it happened
  await makeAppointment(null, 6, 45); // a walk-in with no client record
  await makeAppointment(clientA, 7, 45, "CANCELED"); // never counts
  await makeAppointment(clientA, -3, 45); // FUTURE — not work done yet
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

const get = (query = "") =>
  request(app).get(`/api/insights${query}`).set("Cookie", cookie);

describe("GET /api/insights", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/insights");
    expect(res.status).toBe(401);
  });

  it("echoes the window it measured so no label can drift from it", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("30d");
    expect(res.body.periodLabel).toBe("Last 30 days");
    expect(res.body.bucket).toBe("day");
    expect(res.body.bucketNoun).toBe("day");
    expect(res.body.buckets).toHaveLength(30);
    expect(res.body.periods.map((p: { key: string }) => p.key)).toEqual([
      "7d",
      "30d",
      "90d",
      "180d",
      "365d",
    ]);
  });

  it("counts native appointments AND synced visits, and only inside the window", async () => {
    const res = await get();
    const bucketTotal = res.body.buckets.reduce(
      (sum: number, b: { cuts: number }) => sum + b.cuts,
      0,
    );
    // 4 synced visits + 2 native (BOOKED past + walk-in). The 94-day-old visit,
    // the canceled appointment and the future appointment are all excluded.
    expect(bucketTotal).toBe(6);
    expect(res.body.totals.visits).toBe(6);
  });

  it("counts a client-less walk-in as a cut and says so", async () => {
    const res = await get();
    expect(res.body.totals.walkIns).toBe(1);
    // It cannot be attributed to a person, which is why cuts run ahead of
    // clients seen rather than the two silently disagreeing.
    expect(res.body.totals.uniqueClients).toBe(2);
  });

  it("lists the whole menu: booked services ranked, unbooked ones at zero", async () => {
    const res = await get();
    const services = res.body.services as {
      serviceId: string | null;
      name: string;
      count: number;
      revenue: number;
    }[];
    const byName = new Map(services.map((s) => [s.name, s]));
    expect(byName.get("Haircut")).toMatchObject({ count: 2, revenue: 80 });
    // The native service is keyed by its real id, not a free-text name.
    expect(byName.get("Fade")).toMatchObject({ serviceId: fadeId, count: 2, revenue: 90 });
    expect(byName.get("Loc Retwist")?.count).toBe(1);
    expect(byName.get("(no service name)")?.count).toBe(1);
    // A service nobody booked is a finding, not an omission.
    expect(byName.get("Hot Towel Shave")).toMatchObject({
      serviceId: unbookedId,
      count: 0,
      revenue: 0,
    });
    // Booked services rank ahead of unbooked ones.
    expect(services[services.length - 1]!.count).toBe(0);
  });

  it("computes avg ticket over PRICED bookings only", async () => {
    const res = await get();
    // Priced: 40 + 40 + 90 (synced) + 45 + 45 (native) = 260 over 5 bookings.
    // The unpriced walk-in visit counts as a cut but not toward the average.
    expect(res.body.totals.revenue).toBe(260);
    expect(res.body.totals.pricedCount).toBe(5);
    expect(res.body.totals.unpricedCount).toBe(1);
    expect(res.body.totals.avgTicket).toBe(Math.round(260 / 5));
  });

  it("splits new vs returning by first-ever booking in EITHER system", async () => {
    const res = await get();
    expect(res.body.totals.uniqueClients).toBe(2);
    expect(res.body.totals.newClients).toBe(1); // A started inside the window
    expect(res.body.totals.returningClients).toBe(1); // B predates it
  });

  it("reports a busiest weekday and loyalty activity", async () => {
    const res = await get();
    expect(res.body.busiest.weekday).not.toBeNull();
    expect(res.body.busiest.counts).toHaveLength(7);
    const total = (res.body.busiest.counts as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBe(res.body.totals.visits);
    expect(res.body.loyalty).toHaveProperty("punchesEarned");
    expect(res.body.loyalty).toHaveProperty("redemptions");
  });

  it("re-buckets by week and by month for longer ranges", async () => {
    const week = await get("?period=90d");
    expect(week.body.bucket).toBe("week");
    expect(week.body.bucketNoun).toBe("week");
    expect(week.body.buckets).toHaveLength(13);

    const year = await get("?period=365d");
    expect(year.body.bucket).toBe("month");
    expect(year.body.buckets).toHaveLength(12);
    // The 94-day-old visit is inside a year but outside 30 days.
    expect(year.body.totals.visits).toBe(7);
  });

  it("falls back to the default period rather than 400ing on junk", async () => {
    const junk = await get("?period=banana");
    expect(junk.status).toBe(200);
    expect(junk.body.period).toBe("30d");
    expect(junk.body.buckets).toHaveLength(30);
  });

  it("never leaks another shop's numbers", async () => {
    const otherEmail = `ins2-${randomToken(6)}@test.local`;
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherEmail, password, name: "Other", smsAttested: true });
    const otherCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({
        name: "Empty Shop",
        bookingUrl: "https://empty.test",
        rewardLabel: "Free Cut",
        rewardThreshold: 10,
        smsAttested: true,
      });
    const res = await request(app).get("/api/insights").set("Cookie", otherCookie);
    expect(res.body.totals.visits).toBe(0);
    expect(res.body.services).toHaveLength(0);
    const user = await prisma.user.findUnique({ where: { email: otherEmail } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
