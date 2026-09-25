import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { pushLandingFor, runBroadcastWorker } from "../engines/broadcastWorker.js";
import { queueBroadcast } from "../engines/broadcast.js";
import { __setExpoSenderForTests } from "../messaging/push.js";
import { mergeClients } from "../services/client.js";

/**
 * /api/me/announcements - the customer's bell.
 *
 * The contract, in the order a reviewer should check it:
 *   1. A customer sees the broadcasts sent to ONE OF THEIR OWN PROFILES - never
 *      another customer's, never a shop they are not a client of.
 *   2. "A send row exists" is not "it was sent to you": every broadcast freezes
 *      a row for the whole client book, so an unsubscribed or not-in-the-group
 *      client has a SKIPPED row, and it must show them nothing.
 *   3. The unread count is everything newer than the account's marker, and
 *      marking read moves the marker only as far as what was shown.
 *
 * Each customer has a RANDOM phone, so no row from another suite can link.
 */

const app = createApp();
let ownerId: string;
let shopA: string; // X and Y are both clients here
let shopB: string; // only X
let shopC: string; // neither - a stranger's shop
const accountIds = new Set<string>();

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1628${exch}${line}`;
}

async function account(phone: string) {
  const acct = await prisma.customerAccount.create({
    data: { phoneE164: phone, phoneVerifiedAt: new Date() },
  });
  accountIds.add(acct.id);
  return { id: acct.id, token: mintCustomerSession(acct.id, 0) };
}

async function client(shopId: string, phone: string) {
  return prisma.client.create({
    data: { shopId, acuityClientKey: `test:${randomToken(8)}`, firstName: "Jordan", phone, magicToken: randomToken() },
    select: { id: true },
  });
}

type SendStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED" | "ABANDONED";

/**
 * A queued broadcast and its frozen rows, exactly as broadcast.ts and the
 * worker write them: every client in the book gets a row, and a SENT row
 * carries the moment it went.
 */
async function broadcast(
  shopId: string,
  opts: {
    body: string;
    subject?: string;
    queuedAt: Date;
    sends: { clientId: string; status: SendStatus; reason?: string; sentAt?: Date }[];
  },
) {
  const b = await prisma.broadcast.create({
    data: { shopId, channel: "push", subject: opts.subject ?? null, body: opts.body, status: "SENT", queuedAt: opts.queuedAt },
    select: { id: true },
  });
  await prisma.broadcastSend.createMany({
    data: opts.sends.map((s) => ({
      broadcastId: b.id,
      shopId,
      clientId: s.clientId,
      status: s.status,
      reason: s.reason ?? null,
      sentAt: s.status === "SENT" ? (s.sentAt ?? opts.queuedAt) : null,
    })),
  });
  return b.id;
}

const get = (token: string) => request(app).get("/api/me/announcements").set("Authorization", `Bearer ${token}`);
const markRead = (token: string, body: object = {}) =>
  request(app).post("/api/me/announcements/read").set("Authorization", `Bearer ${token}`).send(body);
const idsOf = async (token: string) => (await get(token)).body.announcements.map((a: { id: string }) => a.id);

let X: { id: string; token: string };
let Y: { id: string; token: string };
const ids: Record<string, string> = {};

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const owner = await prisma.user.create({
    data: { email: `ann-owner-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "Owner" },
  });
  ownerId = owner.id;
  const mk = async (name: string) =>
    (
      await prisma.shop.create({
        data: {
          ownerId,
          name,
          slug: `ann-${randomToken(6)}`.toLowerCase(),
          bookingMode: "native",
          webhookSecret: randomToken(),
          compAccess: true,
          timezone: "America/New_York",
        },
        select: { id: true },
      })
    ).id;
  shopA = await mk("Alpha Cuts");
  shopB = await mk("Bravo Salon");
  shopC = await mk("Charlie Fades");

  const phoneX = randomPhone();
  const phoneY = randomPhone();
  const xa = await client(shopA, phoneX);
  const xb = await client(shopB, phoneX);
  const ya = await client(shopA, phoneY);
  const zc = await client(shopC, randomPhone());
  X = await account(phoneX);
  Y = await account(phoneY);

  // Alpha, to everyone: X and Y both got it.
  ids.toBoth = await broadcast(shopA, {
    subject: "Open Friday",
    body: "Two chairs open Friday",
    queuedAt: ago(6 * HOUR),
    sends: [
      { clientId: xa.id, status: "SENT" },
      { clientId: ya.id, status: "SENT" },
    ],
  });
  // Alpha, email: X had unsubscribed, so X's row is SKIPPED. Y got it.
  ids.xUnsubscribed = await broadcast(shopA, {
    body: "Holiday hours",
    queuedAt: ago(5 * HOUR),
    sends: [
      { clientId: xa.id, status: "SKIPPED", reason: "unsubscribed" },
      { clientId: ya.id, status: "SENT" },
    ],
  });
  // Alpha, gold members only: X is not gold.
  ids.xNotInGroup = await broadcast(shopA, {
    body: "Gold members: free line up",
    queuedAt: ago(4 * HOUR),
    sends: [
      { clientId: xa.id, status: "SKIPPED", reason: "not_in_audience" },
      { clientId: ya.id, status: "SENT" },
    ],
  });
  // Bravo: delivered to X.
  ids.xDelivered = await broadcast(shopB, {
    body: "New stylist starting Monday",
    queuedAt: ago(3 * HOUR),
    sends: [{ clientId: xb.id, status: "SENT" }],
  });
  // Bravo: refused by the provider, and a send nobody knows landed.
  ids.xFailed = await broadcast(shopB, {
    body: "Never reached X",
    queuedAt: ago(2 * HOUR),
    sends: [{ clientId: xb.id, status: "FAILED" }],
  });
  ids.xAbandoned = await broadcast(shopB, {
    body: "Maybe reached X",
    queuedAt: ago(2 * HOUR),
    sends: [{ clientId: xb.id, status: "ABANDONED" }],
  });
  // Alpha, still in flight for X.
  ids.xPending = await broadcast(shopA, {
    body: "Still sending",
    queuedAt: ago(1 * HOUR),
    sends: [{ clientId: xa.id, status: "PENDING" }],
  });
  // Charlie: a shop neither X nor Y is a client of.
  ids.stranger = await broadcast(shopC, {
    body: "Charlie's news",
    queuedAt: ago(30 * 60_000),
    sends: [{ clientId: zc.id, status: "SENT" }],
  });
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.size > 0) await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  if (ownerId) {
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

describe("GET /api/me/announcements", () => {
  it("needs a customer session", async () => {
    const res = await request(app).get("/api/me/announcements");
    expect(res.status).toBe(401);
  });

  it("shows X what was delivered to X's own profiles, newest first", async () => {
    const res = await get(X.token);
    expect(res.status).toBe(200);
    expect(res.body.announcements.map((a: { id: string }) => a.id)).toEqual([ids.xDelivered, ids.toBoth]);
    expect(res.body.announcements[0]).toEqual({
      id: ids.xDelivered,
      shop: { name: "Bravo Salon", logoUrl: null },
      title: null,
      body: "New stylist starting Monday",
      sentAt: expect.any(String),
    });
    expect(res.body.announcements[1]).toMatchObject({ shop: { name: "Alpha Cuts" }, title: "Open Friday" });
    expect(res.body.unreadCount).toBe(2);
  });

  it("never shows a client a broadcast they were skipped for, or one that did not reach them", async () => {
    const shown = await idsOf(X.token);
    // SKIPPED: unsubscribed, and not in the group the barber picked.
    expect(shown).not.toContain(ids.xUnsubscribed);
    expect(shown).not.toContain(ids.xNotInGroup);
    // Not delivered: refused, unknown, or not yet gone.
    expect(shown).not.toContain(ids.xFailed);
    expect(shown).not.toContain(ids.xAbandoned);
    expect(shown).not.toContain(ids.xPending);
  });

  it("one customer never sees another's shops, and neither sees a stranger's shop", async () => {
    // Y is at Alpha only: everything Alpha delivered to Y, nothing from Bravo (X's).
    const y = await idsOf(Y.token);
    expect(y).toEqual([ids.xNotInGroup, ids.xUnsubscribed, ids.toBoth]);
    expect(y).not.toContain(ids.stranger);
    expect(await idsOf(X.token)).not.toContain(ids.stranger);
  });

  it("an account with no shops sees nothing", async () => {
    const lonely = await account(randomPhone());
    expect((await get(lonely.token)).body).toEqual({ announcements: [], unreadCount: 0 });
  });
});

describe("only profiles that are really theirs", () => {
  it("an unclaimed profile shows nothing until it is claimed - and then only its own", async () => {
    // A parent and a child on one phone: the contact alone cannot say which
    // record is the account holder's, so neither links.
    const phone = randomPhone();
    const dad = await prisma.client.create({
      data: { shopId: shopC, acuityClientKey: `test:${randomToken(8)}`, firstName: "Dad", phone, magicToken: randomToken() },
      select: { id: true, magicToken: true },
    });
    const kid = await client(shopC, phone);
    const me = await account(phone);
    const toDad = await broadcast(shopC, { body: "For Dad", queuedAt: ago(20 * 60_000), sends: [{ clientId: dad.id, status: "SENT" }] });
    const toKid = await broadcast(shopC, { body: "For the kid", queuedAt: ago(10 * 60_000), sends: [{ clientId: kid.id, status: "SENT" }] });

    expect((await get(me.token)).body).toEqual({ announcements: [], unreadCount: 0 });

    await request(app)
      .post("/api/me/profiles/claim")
      .set("Authorization", `Bearer ${me.token}`)
      .send({ link: dad.magicToken })
      .expect(200);
    const shown = await idsOf(me.token);
    expect(shown).toEqual([toDad]);
    expect(shown).not.toContain(toKid);
  });

  it("a profile claimed by someone else is theirs alone", async () => {
    // One record carrying two people's contacts: neither links on its own,
    // and once one of them claims it with the shop's link, only they see it.
    const phone = randomPhone();
    const email = `ann-${randomToken(6)}@test.local`.toLowerCase();
    const shared = await prisma.client.create({
      data: { shopId: shopC, acuityClientKey: `test:${randomToken(8)}`, firstName: "Sam", phone, email, magicToken: randomToken() },
      select: { id: true, magicToken: true },
    });
    const holder = await account(phone);
    const other = await prisma.customerAccount.create({ data: { emailNormalized: email, emailVerifiedAt: new Date() } });
    accountIds.add(other.id);
    const otherToken = mintCustomerSession(other.id, 0);
    const b = await broadcast(shopC, { body: "Sam's news", queuedAt: ago(5 * 60_000), sends: [{ clientId: shared.id, status: "SENT" }] });

    expect(await idsOf(holder.token)).toEqual([]);
    expect(await idsOf(otherToken)).toEqual([]);

    await request(app)
      .post("/api/me/profiles/claim")
      .set("Authorization", `Bearer ${holder.token}`)
      .send({ link: shared.magicToken })
      .expect(200);
    expect(await idsOf(holder.token)).toEqual([b]);
    expect(await idsOf(otherToken)).toEqual([]);
  });

  it("an archived client's announcements go with it", async () => {
    const phone = randomPhone();
    const c = await client(shopC, phone);
    const me = await account(phone);
    const b = await broadcast(shopC, { body: "Before archiving", queuedAt: ago(15 * 60_000), sends: [{ clientId: c.id, status: "SENT" }] });
    expect(await idsOf(me.token)).toEqual([b]);

    await prisma.client.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
    expect((await get(me.token)).body).toEqual({ announcements: [], unreadCount: 0 });
  });

  it("a profile the customer disowns takes its announcements with it", async () => {
    const phone = randomPhone();
    const mine = await client(shopC, phone);
    const me = await account(phone);
    const b = await broadcast(shopC, { body: "Charlie again", queuedAt: ago(10 * 60_000), sends: [{ clientId: mine.id, status: "SENT" }] });
    expect(await idsOf(me.token)).toEqual([b]);

    const link = await prisma.customerClientLink.findFirstOrThrow({ where: { accountId: me.id, clientId: mine.id } });
    await request(app).post(`/api/me/shops/${link.id}/not-me`).set("Authorization", `Bearer ${me.token}`).expect(200);
    expect((await get(me.token)).body).toEqual({ announcements: [], unreadCount: 0 });
  });

  it("a deleted account's session reads nothing", async () => {
    const phone = randomPhone();
    const c = await client(shopC, phone);
    const me = await account(phone);
    await broadcast(shopC, { body: "Goodbye", queuedAt: ago(5 * 60_000), sends: [{ clientId: c.id, status: "SENT" }] });
    await request(app).delete("/api/me").set("Authorization", `Bearer ${me.token}`).expect(200);
    expect((await get(me.token)).status).toBe(401);
    expect((await markRead(me.token)).status).toBe(401);
  });

  it("the same broadcast to two of one customer's profiles is one announcement", async () => {
    const phone = randomPhone();
    const one = await prisma.client.create({
      data: { shopId: shopC, acuityClientKey: `test:${randomToken(8)}`, firstName: "One", phone, magicToken: randomToken() },
      select: { id: true, magicToken: true },
    });
    const two = await prisma.client.create({
      data: { shopId: shopC, acuityClientKey: `test:${randomToken(8)}`, firstName: "Two", phone, magicToken: randomToken() },
      select: { id: true, magicToken: true },
    });
    const me = await account(phone);
    for (const c of [one, two]) {
      await request(app).post("/api/me/profiles/claim").set("Authorization", `Bearer ${me.token}`).send({ link: c.magicToken }).expect(200);
    }
    const b = await broadcast(shopC, {
      body: "Family news",
      queuedAt: ago(5 * 60_000),
      sends: [
        { clientId: one.id, status: "SENT" },
        { clientId: two.id, status: "SENT" },
      ],
    });
    expect((await get(me.token)).body).toMatchObject({ announcements: [{ id: b }], unreadCount: 1 });
  });
});

describe("POST /api/me/announcements/read", () => {
  it("marks read up to what was shown; one that reaches them later is new", async () => {
    const phone = randomPhone();
    const c = await client(shopB, phone);
    const me = await account(phone);
    await broadcast(shopB, { body: "First", queuedAt: ago(3 * HOUR), sends: [{ clientId: c.id, status: "SENT" }] });
    const shown = (await get(me.token)).body;
    expect(shown.unreadCount).toBe(1);

    // Queued BEFORE the first one, but it only reached them after the list
    // was loaded: it is new to them, and marking what they saw leaves it so.
    await broadcast(shopB, {
      body: "Slow one",
      queuedAt: ago(4 * HOUR),
      sends: [{ clientId: c.id, status: "SENT", sentAt: ago(1 * HOUR) }],
    });
    await markRead(me.token, { through: shown.announcements[0].sentAt }).expect(200);
    expect((await get(me.token)).body.unreadCount).toBe(1);

    await markRead(me.token).expect(200);
    expect((await get(me.token)).body.unreadCount).toBe(0);

    // A slow second phone cannot un-read what the first one read.
    await markRead(me.token, { through: shown.announcements[0].sentAt }).expect(200);
    expect((await get(me.token)).body.unreadCount).toBe(0);

    await broadcast(shopB, { body: "Next week", queuedAt: new Date(), sends: [{ clientId: c.id, status: "SENT" }] });
    expect((await get(me.token)).body.unreadCount).toBe(1);
  });

  it("never marks the future read", async () => {
    const phone = randomPhone();
    const c = await client(shopB, phone);
    const me = await account(phone);
    await markRead(me.token, { through: new Date(Date.now() + 24 * HOUR).toISOString() }).expect(200);
    await broadcast(shopB, { body: "Tomorrow's news, today", queuedAt: new Date(Date.now() + 1000), sends: [{ clientId: c.id, status: "SENT" }] });
    expect((await get(me.token)).body.unreadCount).toBe(1);
  });

  it("only ever moves the caller's own marker, and refuses anything else", async () => {
    const before = await prisma.customerAccount.findUniqueOrThrow({ where: { id: Y.id }, select: { announcementsSeenAt: true } });
    await markRead(X.token, { through: "yesterday" }).expect(400);
    await markRead(X.token, { accountId: Y.id }).expect(400);
    await markRead(X.token).expect(200);
    const after = await prisma.customerAccount.findUniqueOrThrow({ where: { id: Y.id }, select: { announcementsSeenAt: true } });
    expect(after.announcementsSeenAt).toEqual(before.announcementsSeenAt);
  });
});

/**
 * Through the REAL freeze and worker, not hand-written rows: what a barber's
 * "App notification" (the composer's default) actually does for a customer
 * whose only device is the one My ChairBack registered on their account.
 */
describe("a real push broadcast, end to end", () => {
  let shopD: string;
  const pushed: string[] = [];

  beforeAll(async () => {
    shopD = (
      await prisma.shop.create({
        data: {
          ownerId,
          name: "Delta Barbers",
          slug: `ann-${randomToken(6)}`.toLowerCase(),
          bookingMode: "native",
          webhookSecret: randomToken(),
          compAccess: true,
          timezone: "America/New_York",
        },
        select: { id: true },
      })
    ).id;
  });

  beforeEach(() => {
    pushed.length = 0;
    __setExpoSenderForTests({ send: async (to) => void pushed.push(to) });
  });

  afterEach(() => {
    __setExpoSenderForTests(undefined);
  });

  /** A customer of Delta whose only device is on their My ChairBack account. */
  async function appCustomer(opts: { pushEnabled?: boolean } = {}) {
    const phone = randomPhone();
    const c = await client(shopD, phone);
    const me = await account(phone);
    if (opts.pushEnabled === false) {
      await prisma.customerAccount.update({ where: { id: me.id }, data: { pushEnabled: false } });
    }
    const token = `ExponentPushToken[${randomToken(12)}]`;
    await prisma.customerDevice.create({ data: { accountId: me.id, expoPushToken: token, platform: "ios" } });
    // Their first read links the record, as opening the app does.
    await get(me.token).expect(200);
    return { ...me, clientId: c.id, device: token };
  }

  async function sendPush(body: string) {
    const b = await prisma.broadcast.create({
      data: { shopId: shopD, createdByUserId: ownerId, channel: "push", audienceTiers: [], body, status: "DRAFT" },
      select: { id: true },
    });
    const outcome = await queueBroadcast({ shopId: shopD, broadcastId: b.id });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    return b.id;
  }

  const rowFor = (broadcastId: string, clientId: string) =>
    prisma.broadcastSend.findUniqueOrThrow({ where: { broadcastId_clientId: { broadcastId, clientId } } });

  it("reaches an app-only customer's phone, and stays in their Announcements", async () => {
    const me = await appCustomer();
    const b = await sendPush("Closed Monday for the holiday");
    // Frozen as reachable, not written off as "hasn't installed the app".
    expect((await rowFor(b, me.clientId)).status).toBe("PENDING");

    await runBroadcastWorker({ shopId: shopD });
    expect((await rowFor(b, me.clientId)).status).toBe("SENT");
    expect(pushed).toContain(me.device);
    expect((await get(me.token)).body).toMatchObject({ announcements: [{ id: b }], unreadCount: 1 });
  });

  it("a customer who switched notifications off is still left out, as delivery would", async () => {
    const me = await appCustomer({ pushEnabled: false });
    // Somebody reachable, so the blast itself is not refused as "no recipients".
    await appCustomer();
    const b = await sendPush("Walk-ins welcome Saturday");
    expect(await rowFor(b, me.clientId)).toMatchObject({ status: "SKIPPED", reason: "no_app" });
    await runBroadcastWorker({ shopId: shopD });
    expect(pushed).not.toContain(me.device);
    expect(await idsOf(me.token)).not.toContain(b);
  });

  it("a send that settles after the list was read is still new, even within one worker pass", async () => {
    const me = await appCustomer();
    const first = await sendPush("Open late Friday");
    const second = await sendPush("Correction: open late THURSDAY");

    // One pass settles both, one after the other. Each row carries the moment
    // IT settled - so marking read through the first (what the customer saw
    // when its push brought them in) leaves the second one new.
    await runBroadcastWorker({ shopId: shopD });
    const a = await rowFor(first, me.clientId);
    const z = await rowFor(second, me.clientId);
    expect(a.status).toBe("SENT");
    expect(z.status).toBe("SENT");
    expect(z.sentAt!.getTime()).toBeGreaterThan(a.sentAt!.getTime());

    await markRead(me.token, { through: a.sentAt!.toISOString() }).expect(200);
    const after = (await get(me.token)).body;
    expect(after.announcements.map((x: { id: string }) => x.id)).toEqual([second, first]);
    expect(after.unreadCount).toBe(1);
  });
});

describe("a shop merging duplicate records", () => {
  it("keeps what reached either record in the customer's list, once each", async () => {
    const phone = randomPhone();
    const winner = await client(shopC, phone);
    // The duplicate carries a different number, so it never linked on its own.
    const loser = await client(shopC, randomPhone());
    const me = await account(phone);
    const toLoser = await broadcast(shopC, {
      body: "Sent to the duplicate",
      queuedAt: ago(40 * 60_000),
      sends: [{ clientId: loser.id, status: "SENT" }],
    });
    const toBoth = await broadcast(shopC, {
      body: "Sent to both records",
      queuedAt: ago(30 * 60_000),
      sends: [
        { clientId: winner.id, status: "SENT" },
        { clientId: loser.id, status: "SENT" },
      ],
    });
    expect(await idsOf(me.token)).toEqual([toBoth]);

    const merged = await mergeClients(shopC, winner.id, loser.id);
    expect(merged.ok).toBe(true);
    expect(await idsOf(me.token)).toEqual([toBoth, toLoser]);

    // Anything the archived duplicate is sent AFTER the merge is not theirs.
    const afterMerge = await broadcast(shopC, {
      body: "After the merge",
      queuedAt: new Date(Date.now() + 1000),
      sends: [{ clientId: loser.id, status: "SENT" }],
    });
    expect(await idsOf(me.token)).not.toContain(afterMerge);
  });
});

describe("a broadcast push", () => {
  it("carries the announcement cue the app routes on, and still lands on the booking page", () => {
    const shop = { name: "Alpha Cuts", slug: "alpha", ownerEmail: null, postal: null, rewardsEnabled: false };
    expect(pushLandingFor(shop, "bc_1")).toMatch(/\/book\/alpha\?announcement=bc_1$/);
    expect(pushLandingFor({ ...shop, slug: null }, "bc_1")).toMatch(/\?announcement=bc_1$/);
  });
});
