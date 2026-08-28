import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { rotateAllMagicTokens } from "../services/rewardsRotation.js";

/**
 * magicToken rotation - the corpus retirement.
 *
 * The load-bearing property: rotation KILLS the old link (the /api/rewards
 * resolve is the oracle) and only the right hands can pull the trigger -
 * a manager for one of THEIR clients, an isAdmin user for the platform.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let ownerCookie: string;
let otherCookie: string;
let shopId: string;
let adminCookie: string;

async function signupAndShop(label: string, shopName: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: shopName, smsAttested: true });
  return { cookie: c, shopId: shop.body.id as string, email };
}

async function makeClient(cookie: string): Promise<{ id: string; token: string }> {
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName: "Rotatee" });
  expect(created.status).toBe(201);
  const row = await prisma.client.findUnique({ where: { id: created.body.id } });
  return { id: created.body.id as string, token: row!.magicToken };
}

const rotate = (id: string, c: string) =>
  request(app).post(`/api/dashboard/clients/${id}/rotate-rewards-link`).set("Cookie", c);

beforeAll(async () => {
  const a = await signupAndShop("rot-owner", "Rotate Cuts");
  ownerCookie = a.cookie;
  shopId = a.shopId;
  const b = await signupAndShop("rot-other", "Other Rotate");
  otherCookie = b.cookie;
  // The platform admin: isAdmin is a hand-set column, so set it by hand.
  const c = await signupAndShop("rot-admin", "Admin Rotate");
  adminCookie = c.cookie;
  await prisma.user.update({ where: { email: c.email }, data: { isAdmin: true } });
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

describe("manager rotation", () => {
  it("kills the old link and mints a working new one", async () => {
    const { id, token } = await makeClient(ownerCookie);
    // Sanity: the old link resolves before rotation.
    expect((await request(app).get(`/api/rewards/${token}`)).status).toBe(200);

    const res = await rotate(id, ownerCookie);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id } });
    expect(after!.magicToken).not.toBe(token);
    // The oracle: old dead, new alive.
    expect((await request(app).get(`/api/rewards/${token}`)).status).toBe(404);
    expect((await request(app).get(`/api/rewards/${after!.magicToken}`)).status).toBe(200);
  });

  it("is shop-scoped: another shop's client is a plain 404, token untouched", async () => {
    const { id, token } = await makeClient(ownerCookie);
    const res = await rotate(id, otherCookie);
    expect(res.status).toBe(404);
    const after = await prisma.client.findUnique({ where: { id } });
    expect(after!.magicToken).toBe(token);
  });
});

describe("platform rotation", () => {
  it("requires the exact confirm phrase", async () => {
    for (const body of [{}, { confirm: "rotate all rewards links" }, { confirm: "yes" }]) {
      const res = await request(app)
        .post("/api/admin-portal/rotate-all-rewards-links")
        .set("Cookie", adminCookie)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("refuses a non-admin outright", async () => {
    const res = await request(app)
      .post("/api/admin-portal/rotate-all-rewards-links")
      .set("Cookie", ownerCookie)
      .send({ confirm: "ROTATE ALL REWARDS LINKS" });
    expect(res.status).toBeGreaterThanOrEqual(403);
  });

  // The route's happy path is pinned in rewardsRotationRoute.test.ts with the
  // service MOCKED: a real unscoped run here would rotate every client in the
  // shared test DB and flake every suite running beside this one. The batch
  // machinery itself is proven below, shop-scoped.
  it("batch machinery: keyset pages through and kills every link in scope", async () => {
    const clients = [];
    for (let i = 0; i < 5; i++) clients.push(await makeClient(ownerCookie));
    const outsider = await makeClient(otherCookie);

    // batchSize 2 forces three keyset pages over five rows.
    const result = await rotateAllMagicTokens({ scope: { shopId }, batchSize: 2 });
    expect(result.rotated).toBeGreaterThanOrEqual(5);

    for (const c of clients) {
      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after!.magicToken).not.toBe(c.token);
      expect((await request(app).get(`/api/rewards/${c.token}`)).status).toBe(404);
      expect((await request(app).get(`/api/rewards/${after!.magicToken}`)).status).toBe(200);
    }
    // The scope held: the other shop's client kept its token.
    const kept = await prisma.client.findUnique({ where: { id: outsider.id } });
    expect(kept!.magicToken).toBe(outsider.token);
  });
});
