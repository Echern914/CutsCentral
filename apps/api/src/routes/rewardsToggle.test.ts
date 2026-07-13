import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { earnPunchForVisitInTx, redeemReward } from "../services/punch.js";
import { createApp } from "../app.js";

/**
 * The master rewards switch: OFF = no earning, no redeeming, no rewards data on
 * the client/public payloads - while booking keeps working and the LEDGER is
 * never mutated (balances survive an off/on round-trip intact). Plus the
 * concurrent double-redeem race the DB-level atomicity must win.
 */
const app = createApp();
const email = `rtoggle-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let shopId: string;
let slug: string;
let clientId: string;
let magicToken: string;
let rewardId: string;

async function setRewards(on: boolean) {
  const res = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ rewardsEnabled: on });
  expect(res.status).toBe(200);
  expect(res.body.rewardsEnabled).toBe(on);
}

async function earnOnce(punches = 1): Promise<void> {
  // Drive the SAME primitive every earn path uses, via a completed visit.
  for (let i = 0; i < punches; i++) {
    const visit = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `rt-${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.$transaction((tx) =>
      earnPunchForVisitInTx(
        tx,
        { id: shopId, punchesPerVisit: 1 },
        clientId,
        visit.id,
        "Cut",
        new Date(),
      ),
    );
  }
}

async function balance(): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "R", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Toggle Cuts", bookingUrl: "https://toggle.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  slug = shop.body.slug;

  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `rt-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
    },
    select: { id: true, magicToken: true },
  });
  clientId = client.id;
  magicToken = client.magicToken;

  const reward = await prisma.reward.create({
    data: { shopId, name: "Free Cut", punchCost: 2 },
    select: { id: true },
  });
  rewardId = reward.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("rewardsEnabled gate", () => {
  it("a NEW shop starts with rewards OFF: no earning, redeeming 403s", async () => {
    // (This shop was just created - default false, no opt-in yet.)
    await earnOnce();
    expect(await balance()).toBe(0); // visit recorded, NO ledger row

    const redeem = await request(app)
      .post(`/api/dashboard/redeem/${clientId}`)
      .set("Cookie", cookie)
      .send({ rewardId });
    expect(redeem.status).toBe(403);
    expect(redeem.body.error).toBe("rewards_disabled");
  });

  it("client /r/ and public /s/ payloads carry zero rewards surfaces while off", async () => {
    const r = await request(app).get(`/api/rewards/${magicToken}`);
    expect(r.status).toBe(200);
    expect(r.body.shop.rewardsEnabled).toBe(false);
    expect(r.body.rewards).toEqual([]);
    expect(r.body.cards).toEqual([]);
    expect(r.body.redemptions).toEqual([]);
    expect(r.body.punches.balance).toBe(0);
    expect(r.body.wallet.available).toBe(false);
    // The page is still a working hub: shop identity + consent survive.
    expect(r.body.shop.name).toBe("Toggle Cuts");
    expect(r.body.consent).toBeDefined();

    const s = await request(app).get(`/api/page/${slug}`);
    expect(s.status).toBe(200);
    expect(s.body.rewardsEnabled).toBe(false);
    expect(s.body.rewards).toEqual([]);
  });

  it("toggling ON starts earning + redeeming; toggling OFF preserves balances intact", async () => {
    await setRewards(true);
    await earnOnce(2);
    expect(await balance()).toBe(2);

    // OFF: the balance is untouched, redeem refused, nothing hidden is lost.
    await setRewards(false);
    expect(await balance()).toBe(2);
    const refused = await redeemReward(shopId, clientId, rewardId);
    expect(refused).toEqual({ ok: false, reason: "rewards_disabled" });

    // Back ON: the old balance reappears and redeems normally.
    await setRewards(true);
    const r = await request(app).get(`/api/rewards/${magicToken}`);
    expect(r.body.punches.balance).toBe(2);
    const redeem = await request(app)
      .post(`/api/dashboard/redeem/${clientId}`)
      .set("Cookie", cookie)
      .send({ rewardId });
    expect(redeem.status).toBe(200);
    expect(redeem.body.newBalance).toBe(0);
  });

  it("CONCURRENT double-redeem: the atomic balance check lets exactly one through", async () => {
    await setRewards(true);
    await earnOnce(2); // exactly one redemption's worth

    const [a, b] = await Promise.all([
      redeemReward(shopId, clientId, rewardId),
      redeemReward(shopId, clientId, rewardId),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const insufficient = [a, b].filter(
      (r) => !r.ok && r.reason === "insufficient_punches",
    );
    expect(oks).toHaveLength(1);
    expect(insufficient).toHaveLength(1);
    expect(await balance()).toBe(0);
  });

  it("surfaces rewardReady on the booking agenda only while rewards are on", async () => {
    await setRewards(true);
    await earnOnce(3); // >= punchCost again
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ bookingMode: "native", timezone: "UTC" });
    const staff = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", cookie)
      .send({ name: "Sam" });
    const service = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Cut", durationMin: 30, staffIds: [staff.body.id] });
    const startsAt = new Date(Date.now() + 3 * 3600_000);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.body.id,
        serviceId: service.body.id,
        clientId,
        firstName: "Marcus",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
      select: { id: true },
    });

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 24 * 3600_000).toISOString();
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${from}&to=${to}`)
      .set("Cookie", cookie);
    const row = (agenda.body.agenda as { id: string; rewardReady: unknown }[]).find(
      (r) => r.id === appt.id,
    )!;
    expect(row.rewardReady).toEqual({
      rewardId,
      rewardName: "Free Cut",
      punchCost: 2,
    });

    await setRewards(false);
    const agenda2 = await request(app)
      .get(`/api/booking/agenda?from=${from}&to=${to}`)
      .set("Cookie", cookie);
    const row2 = (agenda2.body.agenda as { id: string; rewardReady: unknown }[]).find(
      (r) => r.id === appt.id,
    )!;
    expect(row2.rewardReady).toBeNull();
  });
});
