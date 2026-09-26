import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { identifierDigest } from "../services/customerSignIn.js";

/**
 * TEXTING OFF MUST NOT STRAND A CUSTOMER ON "NEEDS CONNECTING".
 *
 * An imported book routinely holds one person twice: the same email on two
 * records, each under a different phone (they booked from two numbers over the
 * years). Signed in by email, the customer is - correctly - ambiguous there:
 * the identity rules never pick a record from a shared contact. The way
 * through that needs nobody from the shop is to prove the phone, which names
 * ONE record. Turning texting off (#475) refused those codes too, so every new
 * customer signed in by email and stopped at "Needs connecting".
 *
 * Sign-in codes are the one text that keeps going. This suite is also the
 * privacy check: proving a phone opens exactly the record that phone names,
 * never the other record on the shared email.
 */

const app = createApp();
let ownerId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let slot = 0;
const accountIds = new Set<string>();
const usedHashes = new Set<string>();
let sms: SendMessageInput[] = [];

const DAY = 24 * 60 * 60 * 1000;
const octet = () => 1 + Math.floor(Math.random() * 250);
const RUN_IP = `10.${octet()}.${octet()}.${octet()}`;

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  const phone = `+1631${exch}${line}`;
  usedHashes.add(identifierDigest("sms", phone));
  return phone;
}
const randomEmail = () => `dup-${randomToken(6)}@texting-off.test`.toLowerCase();

async function emailAccount(email: string) {
  const acct = await prisma.customerAccount.create({
    data: { emailNormalized: email, emailVerifiedAt: new Date() },
  });
  accountIds.add(acct.id);
  return { id: acct.id, token: mintCustomerSession(acct.id, 0) };
}

/** One imported record: the shared email, its OWN phone, one booking. */
async function importedRecord(email: string, phone: string) {
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${phone}`,
      firstName: "Jordan",
      lastName: "Reyes",
      phone,
      email,
      source: "acuity",
      magicToken: randomToken(),
    },
    select: { id: true },
  });
  slot += 1;
  const startsAt = new Date(Date.now() + 3 * DAY + slot * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: client.id,
      firstName: "Jordan",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return { clientId: client.id, apptKey: `a_${appt.id}` };
}

const get = (path: string, token: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`).set("X-Forwarded-For", RUN_IP);
const send = (path: string, token: string, body: object) =>
  request(app).post(path).set("Authorization", `Bearer ${token}`).set("X-Forwarded-For", RUN_IP).send(body);

async function settle(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("settle: condition never became true");
}

/** "Add a phone" on Profile, end to end: code by text, then verify. */
async function addPhone(token: string, phone: string) {
  const start = await send("/api/me/contact/start", token, { channel: "sms", phone });
  if (start.status !== 200) return { start, verify: null };
  await settle(() => sms.some((s) => s.to === phone));
  const body = [...sms].reverse().find((s) => s.to === phone)!.body;
  const code = /(\d{6})/.exec(body)![1]!;
  const verify = await send("/api/me/contact/verify", token, { channel: "sms", phone, code });
  return { start, verify };
}

function textingOff(signInTexts?: boolean): void {
  process.env.SMS_ENABLED = "false";
  if (signInTexts === undefined) delete process.env.SMS_SIGNIN_ENABLED;
  else process.env.SMS_SIGNIN_ENABLED = signInTexts ? "true" : "false";
  __resetEnvCacheForTests();
}

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sms.push(input);
      return { sid: `SM-off-${sms.length}`, status: "queued" };
    },
  });
  const owner = await prisma.user.create({
    data: { email: `off-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "Owner" },
  });
  ownerId = owner.id;
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId,
        name: "Texting Off Cuts",
        slug: `off-${randomToken(6)}`.toLowerCase(),
        bookingMode: "native",
        webhookSecret: randomToken(),
        compAccess: true,
        timezone: "America/New_York",
        industry: "barber",
        businessTypeSelectedAt: new Date(),
        rewardsEnabled: true,
      },
      select: { id: true },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Barber" } })).id;
  serviceId = (await prisma.service.create({ data: { shopId, name: "Fade", durationMin: 30 } })).id;
});

afterEach(() => {
  process.env.SMS_ENABLED = "true"; // the suites' default (vitest.setup.ts)
  delete process.env.SMS_SIGNIN_ENABLED;
  __resetEnvCacheForTests();
  sms = [];
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  if (accountIds.size > 0) {
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  }
  if (usedHashes.size > 0) {
    await prisma.customerSignInCode.deleteMany({ where: { identifierHash: { in: [...usedHashes] } } });
  }
  if (ownerId) {
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

describe("an email on two imported records, with texting off", () => {
  it("🔴 before: phone codes refused too, so the customer is stuck on 'Needs connecting'", async () => {
    const email = randomEmail();
    const phoneA = randomPhone();
    await importedRecord(email, phoneA);
    await importedRecord(email, randomPhone());
    const me = await emailAccount(email);

    const home = (await get("/api/me/home", me.token)).body;
    expect(home.shops).toEqual([]);
    expect(home.ambiguous).toHaveLength(1);

    // What production did from #475 until this change.
    textingOff(false);
    const { start } = await addPhone(me.token, phoneA);
    expect(start.status).toBe(400);
    expect(start.body.error).toBe("phone_not_supported");
    expect((await get("/api/me/home", me.token)).body.ambiguous).toHaveLength(1);
    expect(await prisma.customerClientLink.count({ where: { accountId: me.id, status: "active" } })).toBe(0);
  });

  it("🔴 after: adding the phone connects them - to the ONE record that phone names", async () => {
    const email = randomEmail();
    const phoneA = randomPhone();
    const mine = await importedRecord(email, phoneA);
    const other = await importedRecord(email, randomPhone());
    const me = await emailAccount(email);
    expect((await get("/api/me/home", me.token)).body.ambiguous).toHaveLength(1);

    textingOff(); // SMS_SIGNIN_ENABLED unset: its default
    const { start, verify } = await addPhone(me.token, phoneA);
    expect(start.status).toBe(200);
    expect(verify?.body.verified).toBe(true);

    const home = (await get("/api/me/home", me.token)).body;
    expect(home.ambiguous).toEqual([]);
    expect(home.shops).toHaveLength(1);

    // Exactly the record the phone names - never the other one on the email.
    const upcoming = (await get("/api/me/appointments", me.token)).body.upcoming as { id: string }[];
    expect(upcoming.map((e) => e.id)).toEqual([mine.apptKey]);
    const links = await prisma.customerClientLink.findMany({
      where: { accountId: me.id, status: "active" },
      select: { clientId: true, matchedBy: true },
    });
    expect(links).toEqual([{ clientId: mine.clientId, matchedBy: "phone" }]);
    expect(links.some((l) => l.clientId === other.clientId)).toBe(false);
  });

  it("a brand-new customer can sign in by phone and lands connected", async () => {
    const email = randomEmail();
    const phoneA = randomPhone();
    const mine = await importedRecord(email, phoneA);
    await importedRecord(email, randomPhone());

    textingOff();
    const start = await request(app)
      .post("/api/customer-auth/start")
      .set("X-Forwarded-For", RUN_IP)
      .send({ channel: "sms", phone: phoneA });
    expect(start.body).toEqual({ ok: true });
    await settle(() => sms.some((s) => s.to === phoneA));
    const code = /(\d{6})/.exec(sms.find((s) => s.to === phoneA)!.body)![1]!;
    const verify = await request(app)
      .post("/api/customer-auth/verify")
      .set("X-Forwarded-For", RUN_IP)
      .send({ channel: "sms", phone: phoneA, code });
    expect(typeof verify.body.token).toBe("string");
    const acct = await prisma.customerAccount.findUniqueOrThrow({ where: { phoneE164: phoneA } });
    accountIds.add(acct.id);

    const upcoming = (await get("/api/me/appointments", verify.body.token)).body.upcoming as { id: string }[];
    expect(upcoming.map((e) => e.id)).toEqual([mine.apptKey]);
  });
});
