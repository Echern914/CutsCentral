import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * POST /api/dashboard/redeem/:clientId - ONE TAP, ONE REDEMPTION.
 *
 * A Redeem whose answer was lost (no signal, a gateway 502 after the API had
 * written it) and was tapped again redeemed a SECOND reward for a client who
 * had punches for two. The screen now sends one requestId per tap and the same
 * one on a retry; the retry is answered from the first redemption, writes
 * nothing, and texts nobody a second confirmation. A screen that sends no
 * requestId keeps working exactly as before.
 */

const notifyRewardRedeemed = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/loyaltyNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/loyaltyNotify.js")>()),
  notifyRewardRedeemed,
}));

const { createApp } = await import("../app.js");
const app = createApp();
const email = `rdm-${randomToken(6)}@test.local`.toLowerCase();
let cookie = "";
let shopId = "";
let rewardId = "";

async function clientWith(punches: number): Promise<string> {
  const created = await request(app).post("/api/dashboard/clients").set("Cookie", cookie).send({ firstName: "Retry" });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await prisma.punchLedger.create({
    data: { shopId, clientId: id, punchesEarned: punches, runningBalance: punches, note: "bonus" },
  });
  return id;
}
const redeem = (clientId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/dashboard/redeem/${clientId}`).set("Cookie", cookie).send(body);
const redemptions = (clientId: string) =>
  prisma.punchLedger.count({ where: { shopId, clientId, punchesRedeemed: { gt: 0 } } });

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Redeem", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Redeem Retry", bookingUrl: "https://redeem.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ rewardsEnabled: true });
  rewardId = (await prisma.reward.create({ data: { shopId, name: "Free Cut", punchCost: 5 } })).id;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

beforeEach(() => notifyRewardRedeemed.mockClear());

describe("🔴 a retried Redeem redeems once", () => {
  it("the retry answers from the first redemption: one row, one text, the same balance", async () => {
    const c = await clientWith(10); // enough for two
    const requestId = `tap-${randomToken(12)}`;

    const first = await redeem(c, { rewardId, requestId });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, newBalance: 5 });
    expect(first.body.replayed).toBeUndefined();

    const retry = await redeem(c, { rewardId, requestId });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, newBalance: 5, replayed: true, reward: { id: rewardId } });

    expect(await redemptions(c)).toBe(1);
    expect(notifyRewardRedeemed).toHaveBeenCalledTimes(1);
  });

  it("the same id on another client is refused (409) and writes nothing", async () => {
    const a = await clientWith(10);
    const b = await clientWith(10);
    const requestId = `tap-${randomToken(12)}`;
    expect((await redeem(a, { rewardId, requestId })).status).toBe(200);
    const reused = await redeem(b, { rewardId, requestId });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("request_reused");
    expect(await redemptions(b)).toBe(0);
  });

  it("a malformed id is refused before anything is written", async () => {
    const c = await clientWith(10);
    expect((await redeem(c, { rewardId, requestId: "short" })).status).toBe(400);
    expect(await redemptions(c)).toBe(0);
  });

  it("an older screen that sends no id redeems exactly as before", async () => {
    const c = await clientWith(10);
    expect((await redeem(c, { rewardId })).body).toMatchObject({ ok: true, newBalance: 5 });
    expect((await redeem(c, { rewardId })).body).toMatchObject({ ok: true, newBalance: 0 });
    expect(await redemptions(c)).toBe(2);
  });
});
