import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { MAX_CONTACT_FANOUT } from "../services/customerIdentity.js";
import { __setExpoSenderForTests, sendPushToClient } from "../messaging/push.js";

/**
 * 🔴 A VERIFIED CONTACT IS NOT PROOF THAT A RECORD IS YOURS.
 *
 * The whole of this suite is one question asked in the ways it actually
 * happens: a parent and a child on one phone number, two people on one
 * mailbox, a barber's own number typed into thirty walk-ins, one record
 * carrying one person's phone and another's email. In every one of them the
 * platform must refuse to guess, expose nothing at all, and offer the one
 * thing that does settle it - the shop's own link to the record.
 *
 * PR #418's duplicate review is the same fact seen from the shop's side: it
 * exists because two records on one contact are routinely different people.
 */

const app = createApp();
const SECRET = "LINKING-PRIVATE-MARKER";

let ownerId: string;
let shopA: string;
let shopB: string;
let staffA: string;
let serviceA: string;
const accountIds = new Set<string>();
const extraShopIds: string[] = [];
let slot = 0;

const DAY = 24 * 60 * 60 * 1000;
const from = (ms: number) => new Date(Date.now() + ms);

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1629${exch}${line}`;
}
const randomEmail = (tag: string) => `${tag}-${randomToken(6)}@link.test`.toLowerCase();

async function account(opts: { phone?: string; email?: string }) {
  const now = new Date();
  const acct = await prisma.customerAccount.create({
    data: {
      phoneE164: opts.phone ?? null,
      phoneVerifiedAt: opts.phone ? now : null,
      emailNormalized: opts.email ?? null,
      emailVerifiedAt: opts.email ? now : null,
    },
  });
  accountIds.add(acct.id);
  return { id: acct.id, token: mintCustomerSession(acct.id, 0) };
}

async function client(
  shopId: string,
  over: { phone?: string | null; email?: string | null; firstName?: string } = {},
) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `link:${randomToken(8)}`,
      firstName: over.firstName ?? "Jordan",
      phone: over.phone ?? null,
      email: over.email ?? null,
      magicToken: randomToken(),
      notes: `${SECRET} note`,
    },
    select: { id: true, magicToken: true },
  });
}

async function booking(shopId: string, clientId: string) {
  slot += 1;
  const startsAt = new Date(from(2 * DAY).getTime() + slot * 60_000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: staffA,
      serviceId: serviceA,
      clientId,
      firstName: "Jordan",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

const get = (path: string, token: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);
const send = (path: string, token: string, body: object = {}) =>
  request(app).post(path).set("Authorization", `Bearer ${token}`).send(body);

const homeOf = async (token: string) => (await get("/api/me/home", token)).body;

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const owner = await prisma.user.create({
    data: { email: `link-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "Owner" },
  });
  ownerId = owner.id;
  const mk = (name: string) =>
    prisma.shop.create({
      data: {
        ownerId,
        name,
        slug: `link-${randomToken(6)}`.toLowerCase(),
        bookingMode: "native",
        webhookSecret: randomToken(),
        compAccess: true,
        timezone: "America/New_York",
        industry: "barber",
        businessTypeSelectedAt: new Date(),
        rewardsEnabled: true,
      },
      select: { id: true },
    });
  shopA = (await mk("Linking Cuts")).id;
  shopB = (await mk("Second Chair")).id;
  staffA = (await prisma.staff.create({ data: { shopId: shopA, name: "Drick" } })).id;
  serviceA = (await prisma.service.create({ data: { shopId: shopA, name: "Fade", durationMin: 30 } })).id;
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  __setExpoSenderForTests(undefined);
  if (accountIds.size > 0) {
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  }
  if (extraShopIds.length > 0) {
    await prisma.shop.deleteMany({ where: { id: { in: extraShopIds } } });
  }
  if (ownerId) {
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

describe("one contact, more than one person", () => {
  it("🔴 a parent and a child on one phone: nothing is opened, and nothing is shown", async () => {
    const phone = randomPhone();
    const dad = await client(shopA, { phone, firstName: "Marcus" });
    const kid = await client(shopA, { phone, firstName: "Marcus Jr" });
    const appt = await booking(shopA, kid.id);
    const me = await account({ phone });

    const home = await homeOf(me.token);
    expect(home.shops).toEqual([]);
    expect(home.next).toBeNull();
    expect(home.rewards).toEqual([]);
    // The shop is named - the customer has to know where to connect - and
    // nothing else about either profile is.
    expect(home.ambiguous).toHaveLength(1);
    expect(home.ambiguous[0]).toMatchObject({ name: "Linking Cuts" });
    const body = JSON.stringify(home);
    expect(body).not.toContain("Marcus");
    expect(body).not.toContain(dad.magicToken);
    expect(body).not.toContain(kid.magicToken);

    // ...and no door round the side, either.
    expect((await get(`/api/me/appointments/a_${appt.id}`, me.token)).status).toBe(404);
    expect((await get(`/api/me/appointments/a_${appt.id}/manage`, me.token)).status).toBe(404);
    expect((await get("/api/me/appointments", me.token)).body.upcoming).toEqual([]);
    expect(await prisma.customerClientLink.count({ where: { accountId: me.id, status: "active" } })).toBe(0);
  });

  it("two people on one mailbox are just as ambiguous", async () => {
    const email = randomEmail("shared");
    await client(shopA, { email });
    await client(shopA, { email: `  ${email.toUpperCase()} ` }); // as typed, still the same address
    const me = await account({ email });
    const home = await homeOf(me.token);
    expect(home.shops).toEqual([]);
    expect(home.ambiguous).toHaveLength(1);
  });

  it("a contact on a crowd of records is a placeholder: nothing linked, no shop listed", async () => {
    const email = randomEmail("placeholder");
    // One record each at enough shops that no single shop is ambiguous - only
    // the fan-out says this address cannot be one person's.
    let lastShop = "";
    let lastClient = "";
    for (let i = 0; i <= MAX_CONTACT_FANOUT; i++) {
      const shop = await prisma.shop.create({
        data: {
          ownerId,
          name: `Placeholder ${i}`,
          slug: `ph-${randomToken(6)}`.toLowerCase(),
          webhookSecret: randomToken(),
          timezone: "America/New_York",
        },
        select: { id: true },
      });
      extraShopIds.push(shop.id);
      lastShop = shop.id;
      lastClient = (await client(shop.id, { email })).id;
    }
    const me = await account({ email });
    const home = await homeOf(me.token);
    expect(home.shops).toEqual([]);
    // Not even a list of where it appears - that would be a map of the shops
    // whoever owns a throwaway address was typed into.
    expect(home.ambiguous).toEqual([]);

    // The same refusal at the OTHER door: a settle the shop triggers (here, a
    // push) must not quietly link what the customer's own read would not.
    __setExpoSenderForTests({ send: async () => {} });
    await sendPushToClient({
      shopId: lastShop,
      clientId: lastClient,
      payload: { title: "t", body: "b", url: "u" },
    });
    expect(await prisma.customerClientLink.count({ where: { accountId: me.id } })).toBe(0);
  });

  it("one record, one contact, one person: linked automatically, as before", async () => {
    const phone = randomPhone();
    const only = await client(shopA, { phone });
    await booking(shopA, only.id);
    const me = await account({ phone });
    const home = await homeOf(me.token);
    expect(home.shops).toHaveLength(1);
    expect(home.ambiguous).toEqual([]);
    expect(home.next).not.toBeNull();
  });

  it("🔴 the second contact to arrive cannot inherit what the first one linked", async () => {
    // One record carries one person's phone and another's email. The phone
    // account signs in first and opens it; then the mailbox's owner signs in.
    const phone = randomPhone();
    const email = randomEmail("contest");
    const c = await client(shopA, { phone, email });
    const first = await account({ phone });
    expect((await homeOf(first.token)).shops).toHaveLength(1);

    const second = await account({ email });
    expect((await homeOf(second.token)).shops).toHaveLength(0);
    // ...and the first account loses it on the spot, not at some later read.
    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: first.id, clientId: c.id },
    });
    expect(link.status).toBe("detached");
    expect(link.statusReason).toBe("contested");
    expect((await homeOf(first.token)).shops).toHaveLength(0);
  });

  it("a shared contact stops the push that a linked record would have sent", async () => {
    const phone = randomPhone();
    const mine = await client(shopA, { phone });
    const me = await account({ phone });
    const token = `ExponentPushToken[${randomToken(12)}]`;
    await send("/api/me/devices", me.token, { expoPushToken: token, platform: "ios" });
    await homeOf(me.token);

    const delivered: string[] = [];
    __setExpoSenderForTests({ send: async (t) => void delivered.push(t) });
    await sendPushToClient({ shopId: shopA, clientId: mine.id, payload: { title: "t", body: "b", url: "u" } });
    expect(delivered).toEqual([token]);

    // A second record appears on that number - the shop booked a family
    // member. The link is now unsafe, and the next push says so WITHOUT
    // waiting for the customer to open the app.
    await client(shopA, { phone, firstName: "Someone Else" });
    delivered.length = 0;
    await sendPushToClient({ shopId: shopA, clientId: mine.id, payload: { title: "t", body: "b", url: "u" } });
    expect(delivered).toEqual([]);
  });
});

describe("connecting the right profile", () => {
  it("🔴 claims exactly one record - the other stays invisible", async () => {
    const phone = randomPhone();
    const dad = await client(shopA, { phone, firstName: "Marcus" });
    const kid = await client(shopA, { phone, firstName: "Marcus Jr" });
    const dadAppt = await booking(shopA, dad.id);
    const kidAppt = await booking(shopA, kid.id);
    const me = await account({ phone });

    const claim = await send("/api/me/profiles/claim", me.token, {
      link: `https://getchairback.com/r/${dad.magicToken}`,
    });
    expect(claim.status).toBe(200);

    const home = await homeOf(me.token);
    expect(home.shops).toHaveLength(1);
    expect(home.ambiguous).toEqual([]);
    const ids = (await get("/api/me/appointments", me.token)).body.upcoming.map(
      (a: { id: string }) => a.id,
    );
    expect(ids).toContain(`a_${dadAppt.id}`);
    expect(ids).not.toContain(`a_${kidAppt.id}`);
    // The other profile's booking is still nobody else's business.
    expect((await get(`/api/me/appointments/a_${kidAppt.id}`, me.token)).status).toBe(404);
    expect((await get(`/api/me/appointments/a_${kidAppt.id}/manage`, me.token)).status).toBe(404);
    // The claimed one can be managed, which is the point of connecting it.
    expect((await get(`/api/me/appointments/a_${dadAppt.id}/manage`, me.token)).status).toBe(200);
  });

  it("a link without the matching contact opens nothing, and says only 'not found'", async () => {
    const stranger = await client(shopB, { phone: randomPhone() });
    const me = await account({ phone: randomPhone() });
    const res = await send("/api/me/profiles/claim", me.token, { link: stranger.magicToken });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect((await homeOf(me.token)).shops).toEqual([]);
  });

  it("a record another account already holds is refused, credential or not", async () => {
    // One record carrying two people's contacts, and both of them holding the
    // link the shop texted to that number.
    const phone = randomPhone();
    const email = randomEmail("holder");
    const shared = await client(shopA, { phone, email });
    const first = await account({ phone });
    const second = await account({ email });

    expect((await send("/api/me/profiles/claim", first.token, { link: shared.magicToken })).status).toBe(200);
    const res = await send("/api/me/profiles/claim", second.token, { link: shared.magicToken });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("claimed_elsewhere");
    expect((await homeOf(second.token)).shops).toEqual([]);
    expect(await prisma.customerClientLink.count({ where: { clientId: shared.id, status: "active" } })).toBe(1);
  });

  it("rotating the shop's link revokes the claim it was made with", async () => {
    const phone = randomPhone();
    const a = await client(shopA, { phone, firstName: "Twin A" });
    await client(shopA, { phone, firstName: "Twin B" });
    const me = await account({ phone });
    expect((await send("/api/me/profiles/claim", me.token, { link: a.magicToken })).status).toBe(200);
    expect((await homeOf(me.token)).shops).toHaveLength(1);

    await prisma.client.update({ where: { id: a.id }, data: { magicToken: randomToken() } });
    const home = await homeOf(me.token);
    expect(home.shops).toEqual([]);
    expect(home.ambiguous).toHaveLength(1);
    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: me.id, clientId: a.id },
    });
    expect(link.status).toBe("detached");
    expect(link.statusReason).toBe("credential_rotated");
  });

  it("🔴 'This isn't me' disowns ONE profile, not the shop", async () => {
    const phone = randomPhone();
    const mine = await client(shopA, { phone, firstName: "Mine" });
    const theirs = await client(shopA, { phone, firstName: "Theirs" });
    const me = await account({ phone });
    // Both are claimed (both links were in the customer's texts).
    await send("/api/me/profiles/claim", me.token, { link: mine.magicToken });
    await send("/api/me/profiles/claim", me.token, { link: theirs.magicToken });
    expect((await homeOf(me.token)).shops).toHaveLength(1);

    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: me.id, clientId: theirs.id, status: "active" },
    });
    expect((await send(`/api/me/shops/${link.id}/not-me`, me.token)).status).toBe(200);

    // The shop is still there, through the profile that IS theirs.
    const home = await homeOf(me.token);
    expect(home.shops).toHaveLength(1);
    const links = await prisma.customerClientLink.findMany({ where: { accountId: me.id } });
    expect(links.find((l) => l.clientId === mine.id)!.status).toBe("active");
    expect(links.find((l) => l.clientId === theirs.id)!.status).toBe("rejected");
  });

  it("a disowned profile is never linked automatically again", async () => {
    const phone = randomPhone();
    const only = await client(shopA, { phone });
    const me = await account({ phone });
    const home = await homeOf(me.token);
    expect(home.shops).toHaveLength(1);
    await send(`/api/me/shops/${home.shops[0].key}/not-me`, me.token);
    for (let i = 0; i < 2; i++) {
      const again = await homeOf(me.token);
      expect(again.shops).toEqual([]);
      expect(again.ambiguous).toEqual([]);
    }
    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { accountId: me.id, clientId: only.id },
    });
    expect(link.status).toBe("rejected");
  });
});
