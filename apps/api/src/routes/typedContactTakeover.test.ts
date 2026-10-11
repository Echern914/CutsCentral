import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession, customerSessionFromToken } from "../auth/customerSession.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { identifierDigest } from "../services/customerSignIn.js";

/**
 * 🔴 A CONTACT TYPED ON A PUBLIC FORM NEVER OPENS SOMEONE ELSE'S RECORD.
 *
 * The attack, as it worked: the booking page finds its client by the TYPED
 * phone, and used to fill that record's blank email with the TYPED email. My
 * ChairBack then linked any app account that proved that email - one record,
 * one contact, nobody else holding it - and handed it the record's visits,
 * rewards and manage links. So a stranger who knew a regular's phone number
 * booked once with it and their own email, signed in with that email, and
 * owned the regular's profile.
 *
 * What still has to work: a record the booking itself CREATED opens to the
 * email that made it, an email the SHOP put on a record opens automatically,
 * and the number's real owner keeps their profile.
 */

const app = createApp();
const ownerEmails: string[] = [];
const accountIds = new Set<string>();
const usedHashes = new Set<string>();
let mail: { to: string; subject: string }[] = [];
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
let hour = 9;

const octet = () => 1 + Math.floor(Math.random() * 250);
const RUN_IP = `10.${octet()}.${octet()}.${octet()}`;

function nextSlot(): string {
  const d = new Date(Date.now() + 2 * 24 * 3600_000);
  d.setUTCHours(hour, 0, 0, 0);
  hour += 1;
  return d.toISOString();
}

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1302${exch}${line}`;
}
const randomEmail = (tag: string) => `${tag}-${randomToken(6)}@takeover.test`.toLowerCase();

async function settle(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("settle: condition never became true");
}

/** The real My ChairBack email sign-in: ask for a code, read it, verify it. */
async function signInWithEmail(email: string): Promise<string> {
  usedHashes.add(identifierDigest("email", email));
  mail = [];
  const start = await request(app)
    .post("/api/customer-auth/start")
    .set("X-Forwarded-For", RUN_IP)
    .send({ channel: "email", email });
  expect(start.status).toBe(200);
  await settle(() => mail.some((m) => m.to === email && /\d{6}/.test(m.subject)));
  const code = /(\d{6})/.exec([...mail].reverse().find((m) => m.to === email)!.subject)![1]!;
  const verify = await request(app)
    .post("/api/customer-auth/verify")
    .set("X-Forwarded-For", RUN_IP)
    .send({ channel: "email", email, code });
  expect(verify.status).toBe(200);
  const token = verify.body.token as string;
  accountIds.add(customerSessionFromToken(token)!.accountId);
  return token;
}

/** A phone the owner proved (what an SMS sign-in leaves behind). */
async function phoneAccount(phone: string): Promise<string> {
  const acct = await prisma.customerAccount.create({
    data: { phoneE164: phone, phoneVerifiedAt: new Date() },
  });
  accountIds.add(acct.id);
  return mintCustomerSession(acct.id, 0);
}

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const homeOf = async (token: string) => (await get("/api/me/home", token)).body;

/** A regular the SHOP put on its book: their phone, no email on file. */
async function regular(phone: string, email: string | null = null) {
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${phone}`,
      magicToken: randomToken(),
      firstName: "Regina",
      lastName: "Regular",
      phone,
      email,
      notes: "REGULAR-PRIVATE-NOTE",
    },
    select: { id: true, magicToken: true },
  });
  const startsAt = new Date(nextSlot());
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: client.id,
      firstName: "Regina",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true, manageToken: true },
  });
  return { ...client, apptId: appt.id, manageToken: appt.manageToken };
}

const bookOnline = (who: { phone: string; email: string }, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: nextSlot(),
      firstName: "Mallory",
      lastName: "Stranger",
      ...who,
      ...extra,
    });

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.DRY_RUN = "true";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async (input) => {
    mail.push({ to: input.to, subject: input.subject });
    return { id: `EMAIL${mail.length}`, status: "sent" };
  });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "custEmail:" } } });

  const owner = `takeover-${randomToken(6)}@test.local`.toLowerCase();
  ownerEmails.push(owner);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: owner, password: "supersecret123", name: "T", smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Takeover Cuts", bookingUrl: "https://t.test", smsAttested: true });
  shopId = shop.body.id;
  slug = (
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 60 })
  ).body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
});

beforeEach(() => {
  mail = [];
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  await prisma.customerSignInCode.deleteMany({ where: { identifierHash: { in: [...usedHashes] } } });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "custEmail:" } } });
  if (accountIds.size > 0) await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (ownerEmails.length) await prisma.user.deleteMany({ where: { email: { in: ownerEmails } } });
  await prisma.$disconnect();
});

describe("🔴 booking with someone else's number and your own email", () => {
  it("does not hand the stranger the regular's profile when they sign in with that email", async () => {
    const phone = randomPhone();
    const victim = await regular(phone);
    const attackerEmail = randomEmail("mallory");

    const booked = await bookOnline({ phone, email: attackerEmail });
    expect(booked.status).toBe(201);

    const token = await signInWithEmail(attackerEmail);
    const home = await homeOf(token);
    expect(home.shops).toEqual([]);
    expect(home.rewards).toEqual([]);
    expect(home.next).toBeNull();
    const body = JSON.stringify(home);
    expect(body).not.toContain(victim.magicToken);
    expect(body).not.toContain("Regina");

    // No door round the side: not the regular's booking, not its manage link,
    // not the list.
    expect((await get(`/api/me/appointments/a_${victim.apptId}`, token)).status).toBe(404);
    expect((await get(`/api/me/appointments/a_${victim.apptId}/manage`, token)).status).toBe(404);
    expect((await get("/api/me/appointments", token)).body.upcoming).toEqual([]);
    const accountId = customerSessionFromToken(token)!.accountId;
    expect(await prisma.customerClientLink.count({ where: { accountId } })).toBe(0);
    expect(await prisma.customerClientLink.count({ where: { clientId: victim.id, status: "active" } })).toBe(0);

    // The record keeps what it had: no email the shop never saw arrives on it.
    const after = await prisma.client.findUniqueOrThrow({ where: { id: victim.id }, select: { email: true } });
    expect(after.email).toBeNull();
    // ...while the booking itself keeps exactly what was typed, so its
    // confirmation still reaches whoever booked it.
    const own = await prisma.appointment.findFirstOrThrow({
      where: { manageToken: booked.body.manageToken },
      select: { email: true, clientId: true },
    });
    expect(own).toEqual({ email: attackerEmail, clientId: victim.id });
  });

  it("a weekly booking on the number does not do it either", async () => {
    const phone = randomPhone();
    const victim = await regular(phone);
    const attackerEmail = randomEmail("weekly");
    const booked = await bookOnline({ phone, email: attackerEmail }, { recurrence: { interval: 1, count: 2 } });
    expect(booked.status).toBe(201);
    const token = await signInWithEmail(attackerEmail);
    expect((await homeOf(token)).shops).toEqual([]);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: victim.id } })).email).toBeNull();
  });

  it("the number's real owner still gets their own profile, automatically", async () => {
    const phone = randomPhone();
    const victim = await regular(phone);
    expect((await bookOnline({ phone, email: randomEmail("other") })).status).toBe(201);
    const token = await phoneAccount(phone);
    const home = await homeOf(token);
    expect(home.shops).toHaveLength(1);
    expect(home.ambiguous).toEqual([]);
    const link = await prisma.customerClientLink.findFirstOrThrow({
      where: { clientId: victim.id, status: "active" },
      select: { matchedBy: true },
    });
    expect(link.matchedBy).toBe("phone");
  });
});

describe("what still links on its own", () => {
  it("a record the booking itself created opens to the email that booked it", async () => {
    const email = randomEmail("newcomer");
    const booked = await bookOnline({ phone: randomPhone(), email });
    expect(booked.status).toBe(201);
    const token = await signInWithEmail(email);
    const home = await homeOf(token);
    expect(home.shops).toHaveLength(1);
    expect(home.next).not.toBeNull();
  });

  it("an email the shop put on the record opens to whoever proves it", async () => {
    const email = randomEmail("onfile");
    await regular(randomPhone(), email);
    const token = await signInWithEmail(email);
    const home = await homeOf(token);
    expect(home.shops).toHaveLength(1);
    expect(home.ambiguous).toEqual([]);
  });
});
