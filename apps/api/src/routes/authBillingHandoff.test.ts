import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { ACTIVE_SHOP_COOKIE_NAME, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { createWebHandoffCode } from "../auth/webHandoff.js";

/**
 * The iOS app's "Manage plan on getchairback.com" opens Safari ALREADY SIGNED
 * IN: the app mints a one-time code, the web exchanges it for a session.
 *
 * Why: Safari used to ask them to sign in, and the website has no Apple
 * sign-in - a barber whose account is an Apple ID could not reach their plan
 * at all, on the day their trial ended with clients booked (2026-11-01).
 */
const app = createApp();
const password = "supersecret123";

async function owner(label: string): Promise<{ cookie: string; userId: string; shopId: string }> {
  const email = `bh-${label}-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: `Handoff ${label}`, smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Handoff ${label}`, bookingUrl: "https://handoff.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { cookie, userId: user.id, shopId: shop.body.shop?.id ?? shop.body.id };
}

let a: Awaited<ReturnType<typeof owner>>;
let b: Awaited<ReturnType<typeof owner>>;
let barber: Awaited<ReturnType<typeof owner>>;

beforeAll(async () => {
  a = await owner("a");
  b = await owner("b");
  barber = await owner("barber");
  // `a` also manages b's shop; `barber` has a chair there.
  await prisma.shopMember.create({ data: { shopId: b.shopId, userId: a.userId, role: "MANAGER" } });
  await prisma.shopMember.create({ data: { shopId: b.shopId, userId: barber.userId, role: "BARBER" } });
});

afterAll(async () => {
  const ids = [a, b, barber].filter(Boolean);
  await prisma.shopMember.deleteMany({ where: { userId: { in: ids.map((x) => x.userId) } } });
  await prisma.shop.deleteMany({ where: { id: { in: ids.map((x) => x.shopId) } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.map((x) => x.userId) } } });
});

async function mint(cookie: string): Promise<request.Response> {
  return request(app).post("/api/billing/handoff").set("Cookie", cookie);
}

async function exchange(code: string): Promise<request.Response> {
  return request(app).post("/api/auth/billing/exchange").send({ code });
}

describe("POST /api/billing/handoff then /api/auth/billing/exchange", () => {
  it("🔴 the code becomes a working session for the SAME person, in their shop", async () => {
    const m = await mint(a.cookie);
    expect(m.status).toBe(200);
    expect(typeof m.body.code).toBe("string");

    const x = await exchange(m.body.code);
    expect(x.status).toBe(200);
    expect(x.body.shopId).toBe(a.shopId);

    // The token is a real session: billing answers for a's shop with it.
    const me = await request(app).get("/api/billing").set("Cookie", `cb_session=${x.body.token}`);
    expect(me.status).toBe(200);
  });

  it("🔴 lands in the shop the app was SHOWING - a team shop, not their own", async () => {
    const m = await mint(`${a.cookie}; ${ACTIVE_SHOP_COOKIE_NAME}=${b.shopId}`);
    expect(m.status).toBe(200);
    const x = await exchange(m.body.code);
    expect(x.status).toBe(200);
    expect(x.body.shopId).toBe(b.shopId);
  });

  it("🔴 single use: a code replayed from Safari's history is refused", async () => {
    const { code } = (await mint(a.cookie)).body as { code: string };
    expect((await exchange(code)).status).toBe(200);
    const again = await exchange(code);
    expect(again.status).toBe(401);
    expect(again.body.token).toBeUndefined();
  });

  it("nobody signed in cannot mint one", async () => {
    expect((await request(app).post("/api/billing/handoff")).status).toBe(401);
  });

  it("a barber's chair can't - billing is the owner's and managers' (the billing router's guard)", async () => {
    const m = await mint(`${barber.cookie}; ${ACTIVE_SHOP_COOKIE_NAME}=${b.shopId}`);
    expect(m.status).toBe(403);
    expect(m.body.code).toBeUndefined();
    // In their OWN shop they are the owner, and can.
    expect((await mint(barber.cookie)).status).toBe(200);
  });

  it("a forged code, garbage, or another flow's code gets nothing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const apple = createWebHandoffCode(a.userId, "apple-handoff", now, a.shopId);
    for (const code of [apple, "x.y", `${apple.split(".")[0]}.forged`]) {
      const x = await exchange(code);
      expect(x.status, code).toBe(401);
      expect(x.body.token).toBeUndefined();
    }
    expect((await request(app).post("/api/auth/billing/exchange").send({})).status).toBe(400);
  });

  it("an expired code is refused", async () => {
    const old = createWebHandoffCode(a.userId, "billing-handoff", Math.floor(Date.now() / 1000) - 120, a.shopId);
    expect((await exchange(old)).status).toBe(401);
  });

  it("a shop they lost access to since is not handed back - their own shop is used instead", async () => {
    const code = createWebHandoffCode(a.userId, "billing-handoff", Math.floor(Date.now() / 1000), barber.shopId);
    const x = await exchange(code);
    expect(x.status).toBe(200);
    expect(x.body.shopId).toBeNull();
  });
});
