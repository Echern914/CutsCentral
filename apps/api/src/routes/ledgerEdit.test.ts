import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Barber-correctable punch ledger, end to end through the HTTP surface: undo a
 * punch and edit an earn's count. This covers the ROUTE-layer logic the service
 * tests don't reach - the reason -> HTTP-status mapping (404 vs 409), the zod
 * bounds on `punches`, the new fields the ledger GET exposes (id / reversed /
 * isCorrection / editable), and that one shop can never touch another's ledger.
 */
const app = createApp();
const emailA = `led-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `led-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let clientId: string;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Ledger Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://ledger.test", smsAttested: true });
  expect(shop.status).toBe(201);
  // Rewards are opt-IN for new shops (default off); this suite exercises loyalty.
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ rewardsEnabled: true });
  return cookie;
}

/** Read the client's punch ledger entries through the dashboard GET. */
async function ledger(cookie: string) {
  const res = await request(app)
    .get(`/api/dashboard/clients/${clientId}/ledger`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as {
    balance: number;
    entries: {
      id: string;
      earned: number;
      redeemed: number;
      reversed: boolean;
      isCorrection: boolean;
      editable: boolean;
      note: string | null;
    }[];
  };
}

beforeAll(async () => {
  cookieA = await signupAndShop(emailA, "Ledger Cuts A");
  cookieB = await signupAndShop(emailB, "Ledger Cuts B");
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookieA)
    .send({ firstName: "Correctable" });
  expect(created.status).toBe(201);
  clientId = created.body.id;
});

afterAll(async () => {
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("ledger reverse/adjust routes", () => {
  it("requires auth", async () => {
    const res = await request(app).post(
      `/api/dashboard/clients/${clientId}/ledger/whatever/reverse`,
    );
    expect(res.status).toBe(401);
  });

  it("the ledger GET exposes the editing fields on a fresh bonus", async () => {
    await request(app)
      .post(`/api/dashboard/clients/${clientId}/bonus`)
      .set("Cookie", cookieA)
      .send({ count: 2 });
    const { entries } = await ledger(cookieA);
    const bonus = entries.find((e) => e.note === "bonus");
    expect(bonus).toBeDefined();
    expect(bonus!.earned).toBe(2);
    expect(bonus!.reversed).toBe(false);
    expect(bonus!.isCorrection).toBe(false);
    expect(bonus!.editable).toBe(true); // an earn-type row is editable
  });

  it("undoes a bonus and restores the balance, marking the original reversed", async () => {
    const start = await ledger(cookieA);
    const bonus = start.entries.find((e) => e.note === "bonus" && !e.reversed)!;
    const before = start.balance;

    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${bonus.id}/reverse`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newBalance).toBe(before - 2);

    const after = await ledger(cookieA);
    expect(after.balance).toBe(before - 2);
    // Original now flagged reversed; a correction row exists and is marked.
    expect(after.entries.find((e) => e.id === bonus.id)!.reversed).toBe(true);
    expect(after.entries.some((e) => e.isCorrection && e.note?.startsWith("undo:"))).toBe(true);
  });

  it("404s reversing an unknown entry id", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/does-not-exist/reverse`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("entry_not_found");
  });

  it("409s reversing the same entry twice", async () => {
    await request(app)
      .post(`/api/dashboard/clients/${clientId}/bonus`)
      .set("Cookie", cookieA)
      .send({ count: 1 });
    const { entries } = await ledger(cookieA);
    const fresh = entries.find((e) => e.note === "bonus" && !e.reversed)!;

    const first = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${fresh.id}/reverse`)
      .set("Cookie", cookieA);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${fresh.id}/reverse`)
      .set("Cookie", cookieA);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_reversed");
  });

  it("409s reversing a correction row (no undo-the-undo)", async () => {
    const { entries } = await ledger(cookieA);
    const correction = entries.find((e) => e.isCorrection)!;
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${correction.id}/reverse`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("is_a_correction");
  });

  it("adjusts an earn's count and validates the punch bounds", async () => {
    await request(app)
      .post(`/api/dashboard/clients/${clientId}/bonus`)
      .set("Cookie", cookieA)
      .send({ count: 2 });
    const start = await ledger(cookieA);
    const earn = start.entries.find((e) => e.editable)!;
    const before = start.balance;

    // Out-of-range punches -> 400 from the zod guard (route-only logic).
    const bad = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${earn.id}/adjust`)
      .set("Cookie", cookieA)
      .send({ punches: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_input");

    // Valid edit up: 2 -> 4 nets +2.
    const ok = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${earn.id}/adjust`)
      .set("Cookie", cookieA)
      .send({ punches: 4 });
    expect(ok.status).toBe(200);
    expect(ok.body.newBalance).toBe(before + 2);
    expect((await ledger(cookieA)).balance).toBe(before + 2);
  });

  it("409s adjusting a redemption (not an earn)", async () => {
    // Build a balance, redeem a reward, then try to "edit count" the redemption.
    await request(app)
      .post(`/api/dashboard/clients/${clientId}/bonus`)
      .set("Cookie", cookieA)
      .send({ count: 5 });
    const reward = await request(app)
      .post("/api/loyalty/rewards")
      .set("Cookie", cookieA)
      .send({ name: "Editless", punchCost: 1 });
    expect(reward.status).toBe(201);
    const redeem = await request(app)
      .post(`/api/dashboard/redeem/${clientId}`)
      .set("Cookie", cookieA)
      .send({ rewardId: reward.body.id });
    expect(redeem.status).toBe(200);

    const { entries } = await ledger(cookieA);
    const redemption = entries.find((e) => e.redeemed > 0 && !e.isCorrection)!;
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${redemption.id}/adjust`)
      .set("Cookie", cookieA)
      .send({ punches: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_an_earn");
  });

  it("cross-tenant: shop B cannot reverse shop A's ledger entry", async () => {
    const { entries } = await ledger(cookieA);
    const target = entries.find((e) => e.editable) ?? entries[0]!;
    // B's session, A's client id + entry id: the client lookup is shop-scoped,
    // so B gets a 404 (the client isn't theirs) - never touches A's ledger.
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/ledger/${target.id}/reverse`)
      .set("Cookie", cookieB);
    expect(res.status).toBe(404);
    // And A's entry is untouched (still not reversed if it was editable).
    const after = await ledger(cookieA);
    expect(after.entries.find((e) => e.id === target.id)?.reversed).toBe(
      entries.find((e) => e.id === target.id)?.reversed,
    );
  });
});
