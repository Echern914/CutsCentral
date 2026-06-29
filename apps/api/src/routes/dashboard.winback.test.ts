import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, randomToken } from "@chairback/config";
import { forShop, prisma, Prisma } from "@chairback/db";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";

/**
 * Dashboard win-back ("Growth Agent") surfacing: the /stats card numbers
 * (clients re-engaged this month + REAL summed recovered $), and the
 * /winback-preview dry-run that lists who the agent would re-engage.
 */
const app = createApp();
const email = `wbdash-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookie: string;
let shopId: string;

async function signupAndShop(): Promise<void> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "WB Dash", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "WB Dash Cuts", bookingUrl: "https://wbdash.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
}

beforeAll(async () => {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async () => ({ sid: "SM-fake", status: "queued" }),
  });
  await signupAndShop();
  // Win-back is opt-in per shop; turn it on so the preview considers the shop.
  // Pin timezone to mid-day UTC offset so the dry-run preview isn't relevant to
  // quiet hours anyway (dry-run is exempt), but keep it deterministic.
  await prisma.shop.update({
    where: { id: shopId },
    data: { winbackTextsEnabled: true },
  });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

/** A deeply-lapsed (120d), consented client with 2 completed visits. */
async function makeLapsedClient(key: string, phone: string) {
  const db = forShop(shopId);
  const now = new Date();
  const client = await db.client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Lapsed",
      phone,
      smsConsentAt: now,
      smsConsentSource: "barber_attest",
      medianIntervalDays: 30,
      lastVisitAt: addDays(now, -120),
    },
    update: {},
  });
  for (let i = 0; i < 2; i++) {
    await db.visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `${key}-v${i}` } },
      create: {
        clientId: client.id,
        acuityAppointmentId: `${key}-v${i}`,
        status: "COMPLETED",
        scheduledAt: addDays(now, -120 - i * 30),
      },
      update: {},
    });
  }
  return client;
}

describe("dashboard /stats win-back metrics", () => {
  it("counts win-back clients re-engaged this month + sums REAL recovered $", async () => {
    const db = forShop(shopId);
    const now = new Date();
    const client = await makeLapsedClient("tel:+13025557001", "+13025557001");

    // The rebooked visit ($45), this month.
    const visit = await db.visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId, acuityAppointmentId: "wb-rebook-1" } },
      create: {
        clientId: client.id,
        acuityAppointmentId: "wb-rebook-1",
        status: "COMPLETED",
        scheduledAt: now,
        price: new Prisma.Decimal(45),
      },
      update: {},
    });
    // A SENT win-back nudge, attributed to that visit this month.
    await db.nudge.create({
      data: {
        clientId: client.id,
        channel: "SMS",
        status: "SENT",
        kind: "winback",
        body: "we miss you",
        sentAt: now,
        resultedInBookingAt: now,
        resultedVisitId: visit.id,
      },
    });

    const res = await request(app).get("/api/dashboard/stats").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.winbackClientsRecovered).toBe(1);
    expect(res.body.winbackDollarsRecovered).toBe(45);
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/dashboard/stats");
    expect(res.status).toBe(401);
  });
});

describe("dashboard /winback-preview", () => {
  it("lists deeply-lapsed clients the agent would re-engage, without sending", async () => {
    await makeLapsedClient("tel:+13025557002", "+13025557002");
    const res = await request(app)
      .post("/api/dashboard/winback-preview")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.summary.dryRun).toBe(true);
    // At least the freshly-added deeply-lapsed client appears in the preview.
    expect(Array.isArray(res.body.clients)).toBe(true);
    expect(res.body.clients.length).toBeGreaterThanOrEqual(1);
    expect(res.body.clients[0]).toHaveProperty("name");
    expect(res.body.clients[0]).toHaveProperty("daysLapsed");
  });
});
