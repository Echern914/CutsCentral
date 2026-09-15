import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";

/**
 * "Add to my shops", and the barber's "saved your shop".
 *
 * The rules under test: a save is found with the same exact lookup as "Find a
 * shop" and refused identically on every miss; the shop learns the saver's
 * name and nothing that could reach them; and only the account that saved a
 * shop can take it back off.
 */
const app = createApp();
const accountIds: string[] = [];
let cookie: string;
let shopA: { id: string; slug: string };
let shopB: { id: string; slug: string };

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1626${exch}${line}`;
}

async function account(opts: {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string;
  email?: string;
}) {
  const now = new Date();
  const a = await prisma.customerAccount.create({
    data: {
      firstName: opts.firstName === undefined ? `Saver${randomToken(4)}` : opts.firstName,
      lastName: opts.lastName ?? null,
      phoneE164: opts.phone ?? null,
      phoneVerifiedAt: opts.phone ? now : null,
      emailNormalized: opts.email ?? null,
      emailVerifiedAt: opts.email ? now : null,
    },
    select: { id: true },
  });
  accountIds.push(a.id);
  return { id: a.id, token: mintCustomerSession(a.id, 0) };
}

const save = (token: string, handle: string) =>
  request(app).post("/api/me/shops/saved").set("Authorization", `Bearer ${token}`).send({ handle });

const unsave = (token: string, key: string) =>
  request(app).delete(`/api/me/shops/saved/${key}`).set("Authorization", `Bearer ${token}`);

async function savedOf(token: string) {
  const res = await request(app).get("/api/me/home").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.saved as { key: string; name: string; handle: string; bookUrl: string }[];
}

async function savedBy() {
  const res = await request(app).get("/api/dashboard/saved-by").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as { total: number; people: Record<string, unknown>[] };
}

async function makeShop(ownerCookie: string, name: string) {
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name, bookingUrl: "https://saved.test", smsAttested: true });
  expect(res.status).toBe(201);
  await prisma.shop.update({ where: { id: res.body.id }, data: { publicPageEnabled: true } });
  return { id: res.body.id as string, slug: res.body.slug as string };
}

async function signup() {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `saved-${randomToken(6)}@test.local`.toLowerCase(), password: "supersecret123", name: "S", smsAttested: true });
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  cookie = await signup();
  shopA = await makeShop(cookie, `Saved Cuts ${randomToken(4)}`);
  shopB = await makeShop(await signup(), `Other Cuts ${randomToken(4)}`);
});

afterAll(async () => {
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe("Add to my shops", () => {
  it("needs a name first, because the shop will see it", async () => {
    const nameless = await account({ firstName: null });
    const res = await save(nameless.token, shopA.slug);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_required");
    expect(await prisma.customerSavedShop.count({ where: { accountId: nameless.id } })).toBe(0);
  });

  it("saves by the exact handle - once, however many taps", async () => {
    const me = await account({});
    expect((await save(me.token, shopA.slug)).status).toBe(200);
    expect((await save(me.token, shopA.slug.toUpperCase())).status).toBe(200);
    expect(await prisma.customerSavedShop.count({ where: { accountId: me.id } })).toBe(1);

    const saved = await savedOf(me.token);
    expect(saved.map((s) => s.handle)).toEqual([shopA.slug]);
    expect(saved[0]!.bookUrl).toBeTruthy();
  });

  it("answers ONE refusal for every miss - an unknown name, or a page switched off", async () => {
    const me = await account({});
    const unknown = await save(me.token, `no-such-shop-${randomToken(6)}`);
    await prisma.shop.update({ where: { id: shopB.id }, data: { publicPageEnabled: false } });
    try {
      const dark = await save(me.token, shopB.slug);
      expect(unknown.status).toBe(404);
      expect(dark.status).toBe(404);
      expect(dark.body).toEqual(unknown.body);
    } finally {
      await prisma.shop.update({ where: { id: shopB.id }, data: { publicPageEnabled: true } });
    }
    expect(await prisma.customerSavedShop.count({ where: { accountId: me.id } })).toBe(0);
  });

  it("a saved shop whose page goes dark drops out of the list, and comes back", async () => {
    const me = await account({});
    expect((await save(me.token, shopB.slug)).status).toBe(200);
    await prisma.shop.update({ where: { id: shopB.id }, data: { publicPageEnabled: false } });
    try {
      expect((await savedOf(me.token)).map((s) => s.handle)).not.toContain(shopB.slug);
    } finally {
      await prisma.shop.update({ where: { id: shopB.id }, data: { publicPageEnabled: true } });
    }
    expect((await savedOf(me.token)).map((s) => s.handle)).toContain(shopB.slug);
  });

  it("a shop the customer already has a profile at is listed once, not twice", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    await prisma.client.create({
      data: { shopId: shopA.id, acuityClientKey: `saved:${randomToken(8)}`, magicToken: randomToken(), phone },
    });
    expect((await save(me.token, shopA.slug)).status).toBe(200);

    const home = await request(app).get("/api/me/home").set("Authorization", `Bearer ${me.token}`);
    expect(home.body.shops.map((s: { name: string }) => s.name)).toHaveLength(1);
    expect((home.body.saved as { handle: string }[]).map((s) => s.handle)).not.toContain(shopA.slug);
  });

  it("taking a shop back off is that account's to do, and nobody else's", async () => {
    const owner = await account({});
    const stranger = await account({});
    expect((await save(owner.token, shopB.slug)).status).toBe(200);
    const [row] = await savedOf(owner.token);

    expect((await unsave(stranger.token, row!.key)).status).toBe(404);
    expect(await prisma.customerSavedShop.count({ where: { accountId: owner.id } })).toBe(1);

    expect((await unsave(owner.token, row!.key)).status).toBe(200);
    expect(await savedOf(owner.token)).toEqual([]);
  });
});

describe("the barber's side: who saved your shop", () => {
  it("🔴 names and dates - nothing that could reach them", async () => {
    const phone = randomPhone();
    // emailNormalized holds lowercase only - it is what Client emails match on.
    const email = `pat-${randomToken(6)}@saved.test`.toLowerCase();
    const pat = await account({ firstName: "Pat", lastName: `Saver${randomToken(4)}`, phone, email });
    expect((await save(pat.token, shopA.slug)).status).toBe(200);

    const list = await savedBy();
    const entry = list.people.find((p) => String(p.name).startsWith("Pat Saver"));
    expect(entry).toBeTruthy();
    expect(Object.keys(entry!).sort()).toEqual(["name", "savedAt"]);
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(phone);
    expect(raw).not.toContain(email);
  });

  it("only this shop's savers", async () => {
    const lee = await account({ firstName: "Lee", lastName: `Elsewhere${randomToken(4)}` });
    expect((await save(lee.token, shopB.slug)).status).toBe(200);
    const names = (await savedBy()).people.map((p) => String(p.name));
    expect(names.some((n) => n.startsWith("Lee Elsewhere"))).toBe(false);
  });

  it("a removed save, or a deleted account, leaves the list", async () => {
    const tag = randomToken(5);
    const kim = await account({ firstName: "Kim", lastName: `Removes${tag}` });
    const ray = await account({ firstName: "Ray", lastName: `Deletes${tag}` });
    expect((await save(kim.token, shopA.slug)).status).toBe(200);
    expect((await save(ray.token, shopA.slug)).status).toBe(200);
    const has = async (prefix: string) =>
      (await savedBy()).people.some((p) => String(p.name).startsWith(prefix));
    expect(await has(`Kim Removes${tag}`)).toBe(true);
    expect(await has(`Ray Deletes${tag}`)).toBe(true);

    const [kimRow] = await savedOf(kim.token);
    expect((await unsave(kim.token, kimRow!.key)).status).toBe(200);
    await prisma.customerAccount.delete({ where: { id: ray.id } });

    expect(await has(`Kim Removes${tag}`)).toBe(false);
    expect(await has(`Ray Deletes${tag}`)).toBe(false);
  });
});
