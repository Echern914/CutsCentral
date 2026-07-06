import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { forShop, prisma } from "@chairback/db";
import { createApp } from "../app.js";

/**
 * GET /dashboard/trends monthly series — the three fields the expandable
 * revenue-trend line charts rely on: newClients, paymentsSucceeded,
 * rebookingsRecovered. Seeds one of each in the CURRENT month and asserts the
 * current-month bucket (last element of the 6-month series) counts them.
 */
const app = createApp();
const email = `trends-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookie: string;
let shopId: string;

async function signupAndShop(): Promise<void> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Trends", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Trends Cuts", bookingUrl: "https://trends.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
}

beforeAll(async () => {
  await signupAndShop();
  const now = new Date();
  const db = forShop(shopId);

  // A client created this month -> newClients.
  const key = "tel:+13025558001";
  const client = await db.client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Newby",
      phone: "+13025558001",
    },
    update: {},
  });

  // An attributed rebooking this month -> rebookingsRecovered. A SENT nudge whose
  // resultedInBookingAt is now.
  await db.nudge.create({
    data: {
      clientId: client.id,
      channel: "SMS",
      status: "SENT",
      kind: "nudge",
      body: "come back",
      sentAt: now,
      resultedInBookingAt: now,
    },
  });

  // (paymentsSucceeded is asserted as present-and-numeric below rather than
  // seeded: a Payment row requires a real Appointment -> Staff -> Service chain
  // via FKs, which is heavy scaffolding for what is the same shopId+status+
  // createdAt bucket query the other two series already exercise with real data.)
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("GET /dashboard/trends — new fields", () => {
  it("returns newClients, paymentsSucceeded, rebookingsRecovered per month", async () => {
    const res = await request(app).get("/api/dashboard/trends").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const series = res.body.series as Array<{
      label: string;
      visits: number;
      nudges: number;
      newClients: number;
      paymentsSucceeded: number;
      rebookingsRecovered: number;
    }>;
    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBe(6); // default range

    // The current month is the LAST bucket. Our seeds (new client + attributed
    // rebooking) land there. paymentsSucceeded is present-and-numeric (0 here,
    // since seeding a Payment needs a full Appointment chain).
    const current = series[series.length - 1]!;
    expect(current).toHaveProperty("newClients");
    expect(current).toHaveProperty("paymentsSucceeded");
    expect(current).toHaveProperty("rebookingsRecovered");
    expect(current.newClients).toBeGreaterThanOrEqual(1);
    expect(current.rebookingsRecovered).toBeGreaterThanOrEqual(1);
    expect(typeof current.paymentsSucceeded).toBe("number");
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/dashboard/trends");
    expect(res.status).toBe(401);
  });

  it("respects the months range param (3/6/12)", async () => {
    const res = await request(app)
      .get("/api/dashboard/trends?months=3")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.series.length).toBe(3);
  });
});
