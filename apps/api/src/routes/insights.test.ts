import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber insights endpoint: weekly buckets, top services (incl. the
 * "(no service)" bucket Square visits land in), priced-only avg ticket,
 * new-vs-returning, busiest weekday, loyalty activity.
 */
const app = createApp();
const email = `ins-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookie: string;
let shopId: string;
let clientA: string; // all visits inside the window -> NEW
let clientB: string; // has an old visit before the window -> RETURNING
let seq = 0;

/** A completed visit `daysAgo` days back at noon UTC. */
async function makeVisit(
  clientId: string,
  daysAgo: number,
  serviceName: string | null,
  price: number | null,
) {
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  when.setUTCHours(12, 0, 0, 0);
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `ins-${++seq}`,
      status: "COMPLETED",
      scheduledAt: when,
      completedAt: when,
      serviceName,
      price,
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
  // Assertions below bucket by shop-local weeks; pin UTC so they're stable
  // regardless of where/when the suite runs.
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });

  for (const key of ["a", "b"]) {
    const created = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: key.toUpperCase() });
    expect(created.status).toBe(201);
    if (key === "a") clientA = created.body.id;
    else clientB = created.body.id;
  }

  // Inside the 12-week window:
  await makeVisit(clientA, 2, "Haircut", 40);
  await makeVisit(clientA, 3, "Haircut", 40);
  await makeVisit(clientA, 9, "Loc Retwist", 90);
  await makeVisit(clientB, 4, null, null); // unpriced + no service (Square-like)
  // clientB's history starts BEFORE the window -> returning.
  await makeVisit(clientB, 12 * 7 + 10, "Haircut", 35);
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("GET /api/insights", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/insights");
    expect(res.status).toBe(401);
  });

  it("returns weekly buckets covering only the window", async () => {
    const res = await request(app).get("/api/insights").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.weeks).toHaveLength(12);
    const totalWeekVisits = res.body.weeks.reduce(
      (sum: number, w: { visits: number }) => sum + w.visits,
      0,
    );
    // The 4 in-window visits; the 94-day-old one is excluded.
    expect(totalWeekVisits).toBe(4);
    expect(res.body.totals.visits).toBe(4);
  });

  it("ranks services by count with an honest (no service) bucket", async () => {
    const res = await request(app).get("/api/insights").set("Cookie", cookie);
    const services = res.body.services as { name: string; count: number; revenue: number }[];
    expect(services[0]).toMatchObject({ name: "Haircut", count: 2, revenue: 80 });
    const names = services.map((s) => s.name);
    expect(names).toContain("Loc Retwist");
    expect(names).toContain("(no service)");
  });

  it("computes avg ticket over PRICED visits only", async () => {
    const res = await request(app).get("/api/insights").set("Cookie", cookie);
    // Priced: 40 + 40 + 90 = 170 over 3 visits (the unpriced one is excluded).
    expect(res.body.totals.revenue).toBe(170);
    expect(res.body.totals.avgTicket).toBe(Math.round(170 / 3));
  });

  it("splits new vs returning by first-ever visit", async () => {
    const res = await request(app).get("/api/insights").set("Cookie", cookie);
    expect(res.body.totals.uniqueClients).toBe(2);
    expect(res.body.totals.newClients).toBe(1); // A started inside the window
    expect(res.body.totals.returningClients).toBe(1); // B predates it
  });

  it("reports a busiest weekday and loyalty activity", async () => {
    const res = await request(app).get("/api/insights").set("Cookie", cookie);
    expect(res.body.busiest.weekday).not.toBeNull();
    expect(res.body.busiest.counts).toHaveLength(7);
    // Each completed visit earned punches (manual creation skips earning, so
    // just assert the shape - the loyalty numbers are exercised elsewhere).
    expect(res.body.loyalty).toHaveProperty("punchesEarned");
    expect(res.body.loyalty).toHaveProperty("redemptions");
  });

  it("honors the weeks parameter and rejects junk", async () => {
    const eight = await request(app).get("/api/insights?weeks=8").set("Cookie", cookie);
    expect(eight.body.weeks).toHaveLength(8);
    const junk = await request(app).get("/api/insights?weeks=999").set("Cookie", cookie);
    expect(junk.body.weeks).toHaveLength(12); // falls back to the default
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
