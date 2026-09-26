import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";

/**
 * "Join shop": a customer becomes a shop's client from the app.
 *
 * The rules under test: the client record carries the names the customer gave
 * and ONLY the contacts their account proved; joining never makes a second
 * record for someone the shop already has; a shop that approves new clients
 * gets a request instead, answered from its Clients page; and a plain "saved
 * your shop" (which never agreed to share a phone) can never be accepted into a
 * client.
 */
const app = createApp();
const accountIds: string[] = [];
let ownerCookie: string;
let open: { id: string; slug: string };
let vetted: { id: string; slug: string };
let otherCookie: string;
let otherShop: { id: string; slug: string };

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1626${exch}${line}`;
}

async function account(opts: { firstName?: string | null; phone?: string; email?: string } = {}) {
  const now = new Date();
  const a = await prisma.customerAccount.create({
    data: {
      firstName: opts.firstName === undefined ? null : opts.firstName,
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

const join = (token: string, body: Record<string, unknown>) =>
  request(app).post("/api/me/shops/join").set("Authorization", `Bearer ${token}`).send(body);

async function home(token: string) {
  const res = await request(app).get("/api/me/home").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as {
    firstName: string | null;
    shops: { name: string; handle: string | null }[];
    saved: { key: string; handle: string; pending: boolean }[];
  };
}

async function savedBy(cookie = ownerCookie) {
  const res = await request(app).get("/api/dashboard/saved-by").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as {
    people: { name: string }[];
    requests: { id: string; name: string; phone: string | null; email: string | null; instagram?: string | null }[];
  };
}

async function signup() {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `join-${randomToken(6)}@test.local`.toLowerCase(), password: "supersecret123", name: "J", smsAttested: true });
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function makeShop(cookie: string, name: string, approveNewClients = false) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  await prisma.shop.update({ where: { id: res.body.id }, data: { publicPageEnabled: true, approveNewClients } });
  return { id: res.body.id as string, slug: res.body.slug as string };
}

const clientsAt = (shopId: string, phone: string) => prisma.client.findMany({ where: { shopId, phone } });

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  ownerCookie = await signup();
  open = await makeShop(ownerCookie, `Open Door Cuts ${randomToken(4)}`);
  vetted = await makeShop(await signup(), `Members Cuts ${randomToken(4)}`, true);
  otherCookie = await signup();
  otherShop = await makeShop(otherCookie, `Across Town Cuts ${randomToken(4)}`, true);
});

afterAll(async () => {
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe("Join shop - an open shop", () => {
  it("makes them a client with the name they gave and the contacts they PROVED, and lists the shop", async () => {
    const phone = randomPhone();
    const email = `jo-${randomToken(6)}@join.test`.toLowerCase();
    const me = await account({ phone, email });

    const res = await join(me.token, { handle: open.slug, firstName: " Jo ", lastName: "Joiner" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("joined");

    const [client, ...more] = await clientsAt(open.id, phone);
    expect(more).toHaveLength(0);
    expect(client).toMatchObject({ firstName: "Jo", lastName: "Joiner", phone, email });
    // Joining is not consent to marketing texts.
    expect(client!.smsConsentAt).toBeNull();

    const h = await home(me.token);
    expect(h.firstName).toBe("Jo");
    expect(h.shops.map((s) => s.handle)).toContain(open.slug);
    expect(h.saved.map((s) => s.handle)).not.toContain(open.slug);
  });

  it("🔴 a typed phone or email is refused outright - only proven contacts reach a shop", async () => {
    const me = await account({ phone: randomPhone() });
    const stranger = randomPhone();
    const res = await join(me.token, { handle: open.slug, firstName: "Sam", phone: stranger });
    expect(res.status).toBe(400);
    expect(await prisma.client.count({ where: { shopId: open.id, phone: stranger } })).toBe(0);
  });

  it("pressing Join twice is still one client", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    expect((await join(me.token, { handle: open.slug, firstName: "Twice", lastName: "Tanner" })).body.status).toBe("joined");
    expect((await join(me.token, { handle: open.slug, firstName: "Twice", lastName: "Tanner" })).body.status).toBe("joined");
    expect(await clientsAt(open.id, phone)).toHaveLength(1);
  });

  it("needs a first name, and makes nothing without one", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    const res = await join(me.token, { handle: open.slug, firstName: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name_required");
    expect(await clientsAt(open.id, phone)).toHaveLength(0);
  });

  it("answers ONE refusal for every miss - an unknown handle, or a page switched off", async () => {
    const me = await account({ phone: randomPhone() });
    const unknown = await join(me.token, { handle: `no-such-shop-${randomToken(6)}`, firstName: "Al" });
    const dark = await makeShop(await signup(), `Dark Cuts ${randomToken(4)}`);
    await prisma.shop.update({ where: { id: dark.id }, data: { publicPageEnabled: false } });
    const off = await join(me.token, { handle: dark.slug, firstName: "Al" });
    expect(unknown.status).toBe(404);
    expect(off.status).toBe(404);
    expect(off.body).toEqual(unknown.body);
    expect(await prisma.client.count({ where: { shopId: dark.id } })).toBe(0);
  });

  it("🔴 never a second record: a shop that already has their number keeps one record, untouched", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    // Two people share this number here (a parent and a child), so the record
    // is not this account's to open on the number alone.
    for (const firstName of ["Parent", "Child"]) {
      await prisma.client.create({
        data: { shopId: open.id, acuityClientKey: `shared:${randomToken(8)}`, magicToken: randomToken(), phone, firstName },
      });
    }
    // No last name and no handle: a customer the shop already knows is never
    // turned away over that - nothing new is made either way.
    const res = await join(me.token, { handle: open.slug, firstName: "Intruder" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("needs_connecting");
    const records = await clientsAt(open.id, phone);
    expect(records.map((c) => c.firstName).sort()).toEqual(["Child", "Parent"]);
  });

  it("a shop they already booked with is simply theirs - joined, nothing new", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    await prisma.client.create({
      data: { shopId: open.id, acuityClientKey: `tel:${phone}`, magicToken: randomToken(), phone, firstName: "Booked" },
    });
    // 🔴 First name only, and still joined: a returning client is never blocked.
    const res = await join(me.token, { handle: open.slug, firstName: "Renamed" });
    expect(res.body.status).toBe("joined");
    const records = await clientsAt(open.id, phone);
    expect(records.map((c) => c.firstName)).toEqual(["Booked"]);
    expect((await home(me.token)).shops.map((s) => s.handle)).toContain(open.slug);
  });

  it("an earlier plain save of the shop gives way to the client relationship", async () => {
    const me = await account({ firstName: "Saver", phone: randomPhone() });
    await request(app).post("/api/me/shops/saved").set("Authorization", `Bearer ${me.token}`).send({ handle: open.slug });
    expect(await prisma.customerSavedShop.count({ where: { accountId: me.id } })).toBe(1);
    expect((await join(me.token, { handle: open.slug, firstName: "Saver", lastName: "Sato" })).body.status).toBe("joined");
    expect(await prisma.customerSavedShop.count({ where: { accountId: me.id } })).toBe(0);
  });
});

describe("Join shop - a shop that approves new clients", () => {
  it("asks instead: no client yet, Pending in their app, and a request on the shop's list", async () => {
    const phone = randomPhone();
    const email = `pen-${randomToken(6)}@join.test`.toLowerCase();
    const me = await account({ phone, email });
    const res = await join(me.token, { handle: vetted.slug, firstName: "Pen", lastName: `Ding${randomToken(3)}` });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(await clientsAt(vetted.id, phone)).toHaveLength(0);

    const saved = (await home(me.token)).saved.find((s) => s.handle === vetted.slug);
    expect(saved?.pending).toBe(true);
  });

  it("accepting makes them a client from their proven contacts, and the shop moves to Book", async () => {
    const phone = randomPhone();
    const email = `acc-${randomToken(6)}@join.test`.toLowerCase();
    const me = await account({ phone, email });
    const tag = randomToken(4);
    await join(me.token, { handle: otherShop.slug, firstName: "Ace", lastName: `Accepted${tag}` });

    const list = await savedBy(otherCookie);
    const req = list.requests.find((r) => r.name === `Ace Accepted${tag}`);
    expect(req).toMatchObject({ phone, email });
    // A request is not also a "saved your shop" name.
    expect(list.people.some((p) => p.name === `Ace Accepted${tag}`)).toBe(false);

    const ok = await request(app).post(`/api/dashboard/saved-by/${req!.id}/accept`).set("Cookie", otherCookie);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("joined");

    expect(await clientsAt(otherShop.id, phone)).toHaveLength(1);
    const h = await home(me.token);
    expect(h.shops.map((s) => s.handle)).toContain(otherShop.slug);
    expect(h.saved.map((s) => s.handle)).not.toContain(otherShop.slug);
    expect((await savedBy(otherCookie)).requests.some((r) => r.id === req!.id)).toBe(false);
  });

  it("declining takes the request away and makes nothing", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    const tag = randomToken(4);
    await join(me.token, { handle: otherShop.slug, firstName: "Dee", lastName: `Declined${tag}` });
    const req = (await savedBy(otherCookie)).requests.find((r) => r.name === `Dee Declined${tag}`);

    const no = await request(app).post(`/api/dashboard/saved-by/${req!.id}/decline`).set("Cookie", otherCookie);
    expect(no.status).toBe(200);
    expect(await clientsAt(otherShop.id, phone)).toHaveLength(0);
    expect((await home(me.token)).saved.map((s) => s.handle)).not.toContain(otherShop.slug);
  });

  it("🔴 only a join request at THIS shop can be answered - never a plain save, never another shop's", async () => {
    const phone = randomPhone();
    const saver = await account({ firstName: "Plain", phone });
    await request(app).post("/api/me/shops/saved").set("Authorization", `Bearer ${saver.token}`).send({ handle: open.slug });
    const plain = await prisma.customerSavedShop.findFirstOrThrow({ where: { accountId: saver.id, shopId: open.id } });
    const accepted = await request(app).post(`/api/dashboard/saved-by/${plain.id}/accept`).set("Cookie", ownerCookie);
    expect(accepted.status).toBe(404);
    expect(await clientsAt(open.id, phone)).toHaveLength(0);

    const asker = await account({ phone: randomPhone() });
    await join(asker.token, { handle: otherShop.slug, firstName: "Else", lastName: "Ellis" });
    const theirs = await prisma.customerSavedShop.findFirstOrThrow({ where: { accountId: asker.id, shopId: otherShop.id } });
    for (const action of ["accept", "decline"]) {
      const res = await request(app).post(`/api/dashboard/saved-by/${theirs.id}/${action}`).set("Cookie", ownerCookie);
      expect(res.status).toBe(404);
    }
    expect(await prisma.customerSavedShop.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("the customer can take their request back", async () => {
    const me = await account({ phone: randomPhone() });
    await join(me.token, { handle: otherShop.slug, firstName: "Undo", lastName: "Upton" });
    const row = (await home(me.token)).saved.find((s) => s.handle === otherShop.slug)!;
    const res = await request(app).delete(`/api/me/shops/saved/${row.key}`).set("Authorization", `Bearer ${me.token}`);
    expect(res.status).toBe(200);
    expect(await prisma.customerSavedShop.count({ where: { accountId: me.id } })).toBe(0);
  });
});

describe("🔴 Join shop - a last name or an Instagram handle, so the shop can tell them apart", () => {
  it("a first name alone makes no record, at an open shop or an approving one", async () => {
    for (const shop of [open, vetted]) {
      const phone = randomPhone();
      const me = await account({ phone });
      const res = await join(me.token, { handle: shop.slug, firstName: "Mike" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: "name_or_instagram_required",
        message: "Add your last name or Instagram so the shop can tell you apart",
      });
      expect(await clientsAt(shop.id, phone)).toHaveLength(0);
      expect(await prisma.customerSavedShop.count({ where: { accountId: me.id } })).toBe(0);
    }
  });

  it("an Instagram handle alone is enough, stored bare and lowercase on the client and the account", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    const res = await join(me.token, {
      handle: open.slug,
      firstName: "Mike",
      instagram: " https://www.instagram.com/Mike.Fades/?hl=en ",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("joined");
    const [client] = await clientsAt(open.id, phone);
    expect(client).toMatchObject({ firstName: "Mike", lastName: null, instagram: "mike.fades" });
    const profile = await request(app).get("/api/me").set("Authorization", `Bearer ${me.token}`);
    expect(profile.body.profile.instagram).toBe("mike.fades");
  });

  it("a last name the account already has counts - it is asked for only when missing", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    await prisma.customerAccount.update({ where: { id: me.id }, data: { lastName: "Already" } });
    const res = await join(me.token, { handle: open.slug, firstName: "Kept" });
    expect(res.body.status).toBe("joined");
    expect((await clientsAt(open.id, phone))[0]).toMatchObject({ lastName: "Already" });
  });

  it("a handle that cannot be one is refused and saves nothing", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    const res = await join(me.token, { handle: open.slug, firstName: "Mike", lastName: "Jones", instagram: "mike fades!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_instagram");
    expect(await clientsAt(open.id, phone)).toHaveLength(0);
    expect((await prisma.customerAccount.findUniqueOrThrow({ where: { id: me.id } })).lastName).toBeNull();
  });

  it("an approving shop's accept carries the handle onto the client", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    // base64url can carry "-", which no Instagram handle can: keep the tag to
    // handle characters or the join is (rightly) refused about 1 run in 11.
    const tag = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "0");
    await join(me.token, { handle: otherShop.slug, firstName: `Ig${tag}`, instagram: `@ig_${tag}` });
    const req = (await savedBy(otherCookie)).requests.find((r) => r.name.startsWith(`Ig${tag}`));
    // The barber deciding who this is sees the handle the customer was asked for.
    expect(req?.instagram).toBe(`ig_${tag}`);
    const ok = await request(app).post(`/api/dashboard/saved-by/${req!.id}/accept`).set("Cookie", otherCookie);
    expect(ok.body.status).toBe("joined");
    expect((await clientsAt(otherShop.id, phone))[0]).toMatchObject({ instagram: `ig_${tag}` });
  });

  it("🔴 an approving shop that already has their number on file still takes the request, name or no name", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    // Two records share the number, so neither opens on it alone - the shop
    // knows this person, the app just cannot say which record is theirs yet.
    for (const firstName of ["Parent", "Child"]) {
      await prisma.client.create({
        data: { shopId: vetted.id, acuityClientKey: `shared:${randomToken(8)}`, magicToken: randomToken(), phone, firstName },
      });
    }
    const res = await join(me.token, { handle: vetted.slug, firstName: "Known" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("🔴 a barber accepting an OLD request (no last name, no handle) is never blocked", async () => {
    const phone = randomPhone();
    const me = await account({ firstName: "Legacy", phone });
    // Recorded before the rule existed: a request row, and a first name only.
    const row = await prisma.customerSavedShop.create({
      data: { accountId: me.id, shopId: otherShop.id, joinRequestedAt: new Date() },
    });
    const ok = await request(app).post(`/api/dashboard/saved-by/${row.id}/accept`).set("Cookie", otherCookie);
    expect(ok.body.status).toBe("joined");
    expect(await clientsAt(otherShop.id, phone)).toHaveLength(1);
  });
});

describe("the shop's setting", () => {
  it("is on the shop's own settings, off by default", async () => {
    const res = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
    expect(res.body.approveNewClients).toBe(false);
    const on = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ approveNewClients: true });
    expect(on.status).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: open.id } })).approveNewClients).toBe(true);
    await prisma.shop.update({ where: { id: open.id }, data: { approveNewClients: false } });
  });
});
