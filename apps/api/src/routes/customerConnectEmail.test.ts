import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { armBackgroundWorkTracking, settleBackgroundWork } from "../backgroundWork.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { suppressionAddressHash } from "../engines/broadcastAudience.js";
import { MAX_CONTACT_FANOUT } from "../services/customerIdentity.js";
import {
  CONNECT_EMAIL_COOLDOWN_MS,
  CONNECT_EMAIL_PER_ACCOUNT_DAILY,
  CONNECT_EMAIL_PER_SHOP_DAILY,
  emailConnectLinks,
} from "../services/connectLinkEmail.js";

/**
 * "EMAIL ME MY LINK" - the Connect screen's way out.
 *
 * The contract, in the order a reviewer should check it:
 *   1. Each candidate profile's link goes to THAT PROFILE'S OWN email on file -
 *      never the account's, never another profile's, never another shop's.
 *   2. The answer is the same whatever is found: a profile with an email, one
 *      without, a key that names nothing.
 *   3. The limits (one per 15 minutes and three a day per shop, ten a day per
 *      account) are taken before anything is looked up, so a 429 says only
 *      "you asked recently".
 *   4. Nothing goes where it cannot belong: a placeholder address, a bounced
 *      one, a profile the customer disowned.
 */

const app = createApp();

let ownerId: string;
let shopA: string;
let shopB: string;
const accountIds = new Set<string>();
const sent: SendEmailInput[] = [];

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1629${exch}${line}`;
}
const mail = (tag: string) => `${tag}-${randomToken(6)}@connect.test`.toLowerCase();

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

async function client(shopId: string, over: { phone?: string | null; email?: string | null } = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `test:${randomToken(8)}`,
      firstName: "Jordan",
      phone: over.phone ?? null,
      email: over.email ?? null,
      magicToken: randomToken(),
    },
    select: { id: true, magicToken: true, email: true },
  });
}

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const ask = (token: string, body: object) =>
  request(app).post("/api/me/profiles/email-link").set("Authorization", `Bearer ${token}`).send(body);

/** The key the home hands the app for a shop it cannot connect. */
async function connectKey(token: string): Promise<string> {
  const home = await get("/api/me/home", token);
  expect(home.status).toBe(200);
  expect(home.body.ambiguous).toHaveLength(1);
  return home.body.ambiguous[0].key as string;
}

/** Two profiles at shop A on one phone: the parent-and-child case. */
async function sharedPhone() {
  const phone = randomPhone();
  const mine = await client(shopA, { phone, email: mail("mine") });
  const theirs = await client(shopA, { phone, email: mail("theirs") });
  const me = await account({ phone, email: mail("account") });
  return { phone, mine, theirs, me };
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  // The platform breaker is a real hourly ledger in the shared test database;
  // repeated runs would drain it and make every "sent nothing" pass for the
  // wrong reason. This suite is about the per-account rules, not that ceiling.
  process.env.CONNECT_EMAIL_HOURLY_CAP = "1000000";
  process.env.CONNECT_EMAIL_DAILY_CAP = "1000000";
  __resetEnvCacheForTests();
  armBackgroundWorkTracking();
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: `test-${randomToken(4)}`, status: "sent" } as never;
  });
  const owner = await prisma.user.create({
    data: { email: `conn-owner-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "Owner" },
  });
  ownerId = owner.id;
  const mk = (name: string) =>
    prisma.shop.create({
      data: {
        ownerId,
        name,
        slug: `conn-${randomToken(6)}`.toLowerCase(),
        bookingMode: "native",
        webhookSecret: randomToken(),
        compAccess: true,
        timezone: "America/New_York",
      },
      select: { id: true },
    });
  shopA = (await mk("Alpha Cuts")).id;
  shopB = (await mk("Bravo Salon")).id;
});

beforeEach(() => {
  sent.length = 0;
});

afterEach(async () => {
  await settleBackgroundWork();
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  delete process.env.CONNECT_EMAIL_HOURLY_CAP;
  delete process.env.CONNECT_EMAIL_DAILY_CAP;
  __resetEnvCacheForTests();
  if (accountIds.size > 0) {
    // This suite's own limit rows; the platform budget's are timestamp-keyed and expire.
    await prisma.rateLimitCounter.deleteMany({
      where: { OR: [...accountIds].map((id) => ({ key: { contains: id } })) },
    });
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  }
  if (ownerId) {
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

describe("where the links go", () => {
  it("each profile's link goes to that profile's own email, and nowhere else", async () => {
    const { mine, theirs, me } = await sharedPhone();
    const key = await connectKey(me.token);

    const res = await ask(me.token, { key });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await settleBackgroundWork();

    expect(sent.map((s) => s.to).sort()).toEqual([mine.email, theirs.email].sort());
    const toMine = sent.find((s) => s.to === mine.email)!;
    const toTheirs = sent.find((s) => s.to === theirs.email)!;
    expect(toMine.text).toContain(`/r/${mine.magicToken}`);
    expect(toMine.text).not.toContain(theirs.magicToken);
    expect(toTheirs.text).toContain(`/r/${theirs.magicToken}`);
    expect(toTheirs.text).not.toContain(mine.magicToken);
    // Never the account's own address: proving it opened nothing.
    expect(sent.map((s) => s.to)).not.toContain(
      (await prisma.customerAccount.findUnique({ where: { id: me.id } }))!.emailNormalized,
    );
    expect(toMine.subject).toContain("Alpha Cuts");
  });

  it("another shop's profiles are never mailed for this shop's key", async () => {
    const { phone, me } = await sharedPhone();
    // Two at the other shop as well, so it is ALSO waiting to be connected -
    // one would simply connect itself and prove nothing.
    const elsewhere = [
      await client(shopB, { phone, email: mail("elsewhere") }),
      await client(shopB, { phone, email: mail("elsewhere") }),
    ];
    const home = await get("/api/me/home", me.token);
    expect(home.body.ambiguous).toHaveLength(2);
    const key = home.body.ambiguous.find((s: { name: string }) => s.name === "Alpha Cuts").key;

    await ask(me.token, { key });
    await settleBackgroundWork();
    expect(sent).toHaveLength(2);
    for (const other of elsewhere) {
      expect(sent.map((s) => s.to)).not.toContain(other.email);
      expect(JSON.stringify(sent)).not.toContain(other.magicToken);
    }
  });

  it("a profile the customer said is not them is never mailed", async () => {
    const { mine, theirs, me } = await sharedPhone();
    await prisma.customerClientLink.create({
      data: {
        accountId: me.id,
        clientId: theirs.id,
        shopId: shopA,
        matchedBy: "phone",
        status: "rejected",
        statusReason: "not_me",
        statusAt: new Date(),
      },
    });
    const key = await connectKey(me.token);

    await ask(me.token, { key });
    await settleBackgroundWork();
    expect(sent.map((s) => s.to)).toEqual([mine.email]);
  });

  it("a placeholder address and a bounced one are skipped", async () => {
    const phone = randomPhone();
    const shared = mail("placeholder");
    // An address on more records than a person has is nobody's own.
    for (let i = 0; i < MAX_CONTACT_FANOUT; i += 1) await client(shopB, { email: shared });
    await client(shopA, { phone, email: shared });
    const bounced = await client(shopA, { phone, email: mail("bounced") });
    await prisma.client.update({ where: { id: bounced.id }, data: { emailSuppressedAt: new Date() } });
    const me = await account({ phone });
    const key = await connectKey(me.token);

    const res = await ask(me.token, { key });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await settleBackgroundWork();
    expect(sent).toHaveLength(0);
  });
});

it("an address the shop's mail bounced from - on any record - is skipped", async () => {
  const { mine, theirs, me } = await sharedPhone();
  await prisma.emailAddressSuppression.create({
    data: { shopId: shopA, addressHash: suppressionAddressHash(shopA, theirs.email)!, kind: "bounce", source: "test" },
  });
  const key = await connectKey(me.token);

  await ask(me.token, { key });
  await settleBackgroundWork();
  expect(sent.map((s) => s.to)).toEqual([mine.email]);
});

describe("🔴 the same answer whatever is found", () => {
  it("profiles without an email, and a key that names nothing, answer exactly like a send", async () => {
    const phone = randomPhone();
    await client(shopA, { phone });
    await client(shopA, { phone });
    const me = await account({ phone });
    const key = await connectKey(me.token);

    const none = await ask(me.token, { key });
    const junk = await ask(me.token, { key: "AAAAAAAAAAAAAAAA" });
    await settleBackgroundWork();
    expect(none.status).toBe(200);
    expect(junk.status).toBe(200);
    expect(none.body).toEqual({ ok: true });
    expect(junk.body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("a malformed key is refused before anything is taken", async () => {
    const me = await account({ phone: randomPhone() });
    expect((await ask(me.token, { key: "short" })).status).toBe(400);
    expect((await ask(me.token, { shopId: shopA })).status).toBe(400);
  });
});

describe("the limits", () => {
  it("a second ask inside 15 minutes is refused and sends nothing more", async () => {
    const { me } = await sharedPhone();
    const key = await connectKey(me.token);
    expect((await ask(me.token, { key })).status).toBe(200);
    await settleBackgroundWork();
    expect(sent).toHaveLength(2);

    const again = await ask(me.token, { key });
    await settleBackgroundWork();
    expect(again.status).toBe(429);
    expect(sent).toHaveLength(2);
  });

  it("one per 15 minutes, three a day per shop, then a fresh day", async () => {
    const { me } = await sharedPhone();
    const key = await connectKey(me.token);
    const t0 = new Date();
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const step = CONNECT_EMAIL_COOLDOWN_MS + 60_000;

    const outcomes = [];
    for (let i = 0; i <= CONNECT_EMAIL_PER_SHOP_DAILY; i += 1) {
      outcomes.push((await emailConnectLinks({ accountId: me.id, shopKey: key, now: at(i * step) })).ok);
    }
    expect(outcomes).toEqual([...Array(CONNECT_EMAIL_PER_SHOP_DAILY).fill(true), false]);
    // Just short of the cooldown is still refused.
    expect(
      (await emailConnectLinks({ accountId: me.id, shopKey: key, now: at(CONNECT_EMAIL_COOLDOWN_MS - 60_000) })).ok,
    ).toBe(false);
    // A day after the first, it starts over - the full three again, not one.
    const nextDay = 25 * 60 * 60_000;
    const fresh = [];
    for (let i = 0; i < CONNECT_EMAIL_PER_SHOP_DAILY; i += 1) {
      fresh.push((await emailConnectLinks({ accountId: me.id, shopKey: key, now: at(nextDay + i * step) })).ok);
    }
    expect(fresh).toEqual(Array(CONNECT_EMAIL_PER_SHOP_DAILY).fill(true));
    await settleBackgroundWork();
  });

  it("an account cannot ask about more than ten shops a day, made-up keys included", async () => {
    const me = await account({ phone: randomPhone() });
    const now = new Date();
    const outcomes = [];
    for (let i = 0; i <= CONNECT_EMAIL_PER_ACCOUNT_DAILY; i += 1) {
      const key = `K${String(i).padStart(15, "0")}`;
      outcomes.push((await emailConnectLinks({ accountId: me.id, shopKey: key, now })).ok);
    }
    expect(outcomes).toEqual([...Array(CONNECT_EMAIL_PER_ACCOUNT_DAILY).fill(true), false]);
  });

  it("the platform ceiling stops sends, and the answer does not change", async () => {
    const { me } = await sharedPhone();
    const key = await connectKey(me.token);
    // A ceiling of one: two profiles to mail, at most one leaves.
    process.env.CONNECT_EMAIL_HOURLY_CAP = "1";
    try {
      const res = await ask(me.token, { key });
      await settleBackgroundWork();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(sent.length).toBeLessThanOrEqual(1);
    } finally {
      process.env.CONNECT_EMAIL_HOURLY_CAP = "1000000";
    }
  });

  it("one account's limit is not another's", async () => {
    const a = await sharedPhone();
    const b = await sharedPhone();
    const keyA = await connectKey(a.me.token);
    const keyB = await connectKey(b.me.token);
    expect((await ask(a.me.token, { key: keyA })).status).toBe(200);
    expect((await ask(b.me.token, { key: keyB })).status).toBe(200);
    await settleBackgroundWork();
    expect(sent).toHaveLength(4);
  });
});
