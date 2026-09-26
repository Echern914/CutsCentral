import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setExpoSenderForTests } from "../messaging/push.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";

/**
 * Two things a shop owner asked for in a live walkthrough:
 *
 *  1. "Nudges should also go to notifications." The barber's Nudge button
 *     only texted - and with texting switched off it did nothing at all. It
 *     now goes to the customer's ChairBack app first (a free push), lands in
 *     the app's bell even when their notifications are off, and texts only
 *     when the app could not deliver and texting is on.
 *  2. "Remove, so it's not stuck there." A sent message stayed on Recent
 *     messages for good. Remove takes it off the list and out of customers'
 *     in-app bell - and KEEPS the row, which is history.
 */

const app = createApp();
const accountIds = new Set<string>();
let cookie: string;
let shop: { id: string; slug: string };
let otherCookie: string;
let otherShop: { id: string; slug: string };

let sms: SendMessageInput[] = [];
let pushed: string[] = [];

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1627${exch}${line}`;
}

async function signup() {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `nudge-${randomToken(6)}@test.local`.toLowerCase(), password: "supersecret123", name: "S", smsAttested: true });
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function makeShop(ownerCookie: string, name: string) {
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name, bookingUrl: "https://nudge.test/book", smsAttested: true });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, slug: res.body.slug as string };
}

/** A timezone where it is daytime NOW, so the 9pm-8am text rule never makes
 *  the texting case depend on when the suite happens to run. */
function daytimeZone(): string {
  const zones = ["America/New_York", "Europe/London", "Asia/Tokyo", "Asia/Kolkata", "Pacific/Honolulu", "Australia/Sydney"];
  for (const tz of zones) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));
    if (hour >= 10 && hour <= 18) return tz;
  }
  return "America/New_York";
}

async function client(shopId: string, opts: { phone?: string; consent?: boolean } = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `nudge:${randomToken(8)}`,
      firstName: "Jordan",
      phone: opts.phone ?? null,
      smsConsentAt: opts.consent ? new Date() : null,
      magicToken: randomToken(),
    },
    select: { id: true },
  });
}

/** A customer signed in to My ChairBack with this phone - so linked to the record carrying it. */
async function appCustomer(phone: string, opts: { device?: boolean } = {}) {
  const acct = await prisma.customerAccount.create({ data: { phoneE164: phone, phoneVerifiedAt: new Date() } });
  accountIds.add(acct.id);
  const token = mintCustomerSession(acct.id, 0);
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  let device: string | null = null;
  if (opts.device) {
    device = `ExponentPushToken[${randomToken(12)}]`;
    await auth(request(app).post("/api/me/devices")).send({ expoPushToken: device, platform: "ios" });
  }
  await auth(request(app).get("/api/me/home")); // settles the link
  return { id: acct.id, token, device };
}

const bell = async (token: string) =>
  (await request(app).get("/api/me/announcements").set("Authorization", `Bearer ${token}`)).body as {
    announcements: { id: string; body: string; shop: { name: string } }[];
  };
const nudge = (clientId: string) => request(app).post(`/api/dashboard/nudge/${clientId}`).set("Cookie", cookie);

function texting(on: boolean) {
  process.env.SMS_ENABLED = on ? "true" : "false";
  __resetEnvCacheForTests();
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  cookie = await signup();
  shop = await makeShop(cookie, `Nudge Cuts ${randomToken(4)}`);
  await prisma.shop.update({ where: { id: shop.id }, data: { timezone: daytimeZone() } });
  otherCookie = await signup();
  otherShop = await makeShop(otherCookie, `Elsewhere ${randomToken(4)}`);
  __setExpoSenderForTests({ send: async (t) => void pushed.push(t) });
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sms.push(input);
      return { sid: `SM-nudge-${sms.length}`, status: "queued" };
    },
  });
});

afterEach(() => {
  texting(true); // the suites' default (vitest.setup.ts)
  sms = [];
  pushed = [];
});

afterAll(async () => {
  __setExpoSenderForTests(undefined);
  __setMessageProviderForTests(undefined);
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.size) await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  await prisma.$disconnect();
});

describe("the barber's Nudge goes to the customer's app", () => {
  it("🔴 texting off: a customer with the app gets it as a notification, and in the bell", async () => {
    texting(false);
    const phone = randomPhone();
    const c = await client(shop.id, { phone, consent: true });
    const me = await appCustomer(phone, { device: true });

    const res = await nudge(c.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channel: "app" });
    expect(pushed).toContain(me.device);
    expect(sms).toHaveLength(0);

    const row = await prisma.nudge.findFirstOrThrow({ where: { clientId: c.id } });
    expect(row).toMatchObject({ channel: "WEB_PUSH", status: "SENT", kind: "nudge" });
    const items = (await bell(me.token)).announcements;
    expect(items.map((a) => a.id)).toContain(`n_${row.id}`);
  });

  it("🔴 notifications off on their phone: it still waits in the app's bell", async () => {
    texting(false);
    const phone = randomPhone();
    const c = await client(shop.id, { phone });
    const me = await appCustomer(phone); // no device registered

    const res = await nudge(c.id);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("app_inbox");
    const row = await prisma.nudge.findFirstOrThrow({ where: { clientId: c.id } });
    expect(row).toMatchObject({ channel: "WEB_PUSH", status: "FAILED", failedReason: "no_push_device" });
    expect((await bell(me.token)).announcements.map((a) => a.id)).toContain(`n_${row.id}`);
  });

  it("no app and texting off: says so, and sends nothing", async () => {
    texting(false);
    const c = await client(shop.id, { phone: randomPhone(), consent: true });
    const res = await nudge(c.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("unreachable");
    expect(res.body.reason).toMatch(/don't have the ChairBack app/);
    expect(sms).toHaveLength(0);
    expect(await prisma.nudge.count({ where: { clientId: c.id } })).toBe(0);
  });

  it("no app and texting on: texted, exactly as before", async () => {
    const phone = randomPhone();
    const c = await client(shop.id, { phone, consent: true });
    const res = await nudge(c.id);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("sms");
    expect(sms.map((m) => m.to)).toEqual([phone]);
  });

  it("the app delivered it: no text is paid for, even with texting on", async () => {
    const phone = randomPhone();
    const c = await client(shop.id, { phone, consent: true });
    await appCustomer(phone, { device: true });
    const res = await nudge(c.id);
    expect(res.body.channel).toBe("app");
    expect(sms).toHaveLength(0);
  });

  it("the bell shows the shop's push nudges - not texts, not other pushes", async () => {
    const phone = randomPhone();
    const c = await client(shop.id, { phone });
    const me = await appCustomer(phone);
    const mk = (data: { channel: "SMS" | "WEB_PUSH"; kind: string; body: string }) =>
      prisma.nudge.create({ data: { shopId: shop.id, clientId: c.id, status: "SENT", sentAt: new Date(), ...data } });
    const winback = await mk({ channel: "WEB_PUSH", kind: "winback", body: "We've missed you" });
    const text = await mk({ channel: "SMS", kind: "nudge", body: "a text" });
    const loyalty = await mk({ channel: "WEB_PUSH", kind: "loyalty", body: "punch earned" });

    const ids = (await bell(me.token)).announcements.map((a) => a.id);
    expect(ids).toContain(`n_${winback.id}`);
    expect(ids).not.toContain(`n_${text.id}`);
    expect(ids).not.toContain(`n_${loyalty.id}`);
  });
});

describe("Remove on Recent messages", () => {
  async function sentBroadcast(shopId: string, clientId: string, status: "SENT" | "QUEUED" = "SENT") {
    const b = await prisma.broadcast.create({
      data: { shopId, channel: "push", subject: `Hello ${randomToken(4)}`, body: "Two chairs open Friday", status, queuedAt: new Date() },
      select: { id: true, subject: true },
    });
    await prisma.broadcastSend.create({
      data: { broadcastId: b.id, shopId, clientId, status: status === "SENT" ? "SENT" : "PENDING", sentAt: status === "SENT" ? new Date() : null },
    });
    return b;
  }
  const list = async () =>
    ((await request(app).get("/api/broadcasts").set("Cookie", cookie)).body.broadcasts as { id: string }[]).map((b) => b.id);
  const remove = (id: string, as = cookie) => request(app).post(`/api/broadcasts/${id}/remove`).set("Cookie", as);

  it("🔴 takes it off the list AND out of the customer's bell - and keeps the row", async () => {
    const phone = randomPhone();
    const c = await client(shop.id, { phone });
    const me = await appCustomer(phone);
    const b = await sentBroadcast(shop.id, c.id);
    expect(await list()).toContain(b.id);
    expect((await bell(me.token)).announcements.map((a) => a.id)).toContain(b.id);

    const res = await remove(b.id);
    expect(res.status).toBe(200);
    expect(await list()).not.toContain(b.id);
    expect((await bell(me.token)).announcements.map((a) => a.id)).not.toContain(b.id);
    const kept = await prisma.broadcast.findUniqueOrThrow({ where: { id: b.id } });
    expect(kept.removedAt).not.toBeNull();
    expect(await prisma.broadcastSend.count({ where: { broadcastId: b.id } })).toBe(1);
  });

  it("a message still going out is refused - pulling it mid-send would look like it stopped", async () => {
    const c = await client(shop.id);
    const b = await sentBroadcast(shop.id, c.id, "QUEUED");
    const res = await remove(b.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("in_flight");
    expect((await prisma.broadcast.findUniqueOrThrow({ where: { id: b.id } })).removedAt).toBeNull();
  });

  it("another shop's message, or one already removed, is the same 404", async () => {
    const theirs = await sentBroadcast(otherShop.id, (await client(otherShop.id)).id);
    expect((await remove(theirs.id)).status).toBe(404);
    expect((await prisma.broadcast.findUniqueOrThrow({ where: { id: theirs.id } })).removedAt).toBeNull();

    const mine = await sentBroadcast(shop.id, (await client(shop.id)).id);
    expect((await remove(mine.id)).status).toBe(200);
    expect((await remove(mine.id)).status).toBe(404);
  });
});
