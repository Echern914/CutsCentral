import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { mintBookingHandoff } from "../auth/bookingHandoff.js";

/**
 * 🔴 BOOKED IN THE APP, SHOWN IN THE APP.
 *
 * "Yo I booked last night for tdy at 3:10 but I went back to the app and it
 * says ion got anything booked tdy." The booking existed; the app said
 * "Nothing is booked right now."
 *
 * The app books on the shop's own web page in a WebView, and that page used to
 * post only what was TYPED - no account at all - so the booking found its
 * client record by the typed phone or email. Whenever that was not the record
 * the account is linked to, the app (which reads only linked records) could
 * not show it. Every case below FAILED before the fix, booked the way the page
 * books them (see the PR for the reproduction run).
 *
 * The fix: the URLs the API hands the app for a shop's page carry a signed
 * handoff (auth/bookingHandoff.ts), the pages pass it to the booking, and the
 * booking lands on the account's own record (services/appBooking.ts). These
 * tests take the handoff from exactly where the app gets it - the storefront
 * URL and a saved shop's Book link - and book with it.
 *
 * And what must NOT change: a typed contact still never opens anybody else's
 * record (#628, typedContactTakeover.test.ts), a handoff never creates a link
 * on its own, and a page without one books exactly as it always has.
 */

const app = createApp();
const accountIds: string[] = [];
const ownerEmails: string[] = [];
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
let hour = 0;
let dayOffset = 2;

function nextSlot(): string {
  if (hour >= 24) {
    hour = 0;
    dayOffset += 1;
  }
  const d = new Date(Date.now() + dayOffset * 24 * 3600_000);
  d.setUTCHours(hour, 0, 0, 0);
  hour += 1;
  return d.toISOString();
}
function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1415${exch}${line}`;
}
const randomEmail = (tag: string) => `${tag}-${randomToken(6)}@applink.test`.toLowerCase();

async function account(opts: { phone?: string; email?: string }) {
  const now = new Date();
  const a = await prisma.customerAccount.create({
    data: {
      firstName: "Dre",
      lastName: "Client",
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

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
interface Home {
  next: { id: string } | null;
  upcomingCount: number;
  shops: { key: string; name: string }[];
  ambiguous: { name: string }[];
  saved: { key: string; bookUrl: string }[];
}
async function home(token: string): Promise<Home> {
  const res = await get("/api/me/home", token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Home;
}

/** The handoff on a URL the API gave the app, exactly as the page reads it. */
function handoffOn(url: string): string {
  const h = new URL(url).searchParams.get("cb_me");
  expect(h).toBeTruthy();
  return h!;
}

/** "Your shops" -> the storefront (/r/<token>?cb_me=...) -> its Book button. */
async function handoffFromStorefront(token: string): Promise<string> {
  const h = await home(token);
  expect(h.shops).toHaveLength(1);
  const res = await get(`/api/me/shops/${h.shops[0]!.key}/storefront`, token);
  expect(res.status).toBe(200);
  expect(new URL(res.body.url).pathname).toMatch(/^\/r\//);
  return handoffOn(res.body.url);
}

/** A shop added by name: its Book link (/book/<slug>?cb_me=...). */
async function handoffFromSavedShop(token: string): Promise<string> {
  const saved = await request(app)
    .post("/api/me/shops/saved")
    .set("Authorization", `Bearer ${token}`)
    .send({ handle: slug });
  expect(saved.status).toBe(200);
  const h = await home(token);
  expect(h.saved).toHaveLength(1);
  expect(new URL(h.saved[0]!.bookUrl).pathname).toBe(`/book/${slug}`);
  return handoffOn(h.saved[0]!.bookUrl);
}

/** What the booking page posts: what was typed, plus the handoff when it has one. */
const book = (
  typed: { phone?: string; email?: string },
  handoff?: string,
  extra: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: nextSlot(),
      firstName: "Dre",
      lastName: "Client",
      ...typed,
      ...(handoff ? { customerHandoff: handoff } : {}),
      ...extra,
    });

async function shopRecord(data: { key: string; phone?: string | null; email?: string | null; archived?: boolean }) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: data.key,
      magicToken: randomToken(),
      firstName: "Dre",
      lastName: "Client",
      phone: data.phone ?? null,
      email: data.email ?? null,
      archivedAt: data.archived ? new Date() : null,
    },
    select: { id: true, magicToken: true },
  });
}

const clientOf = (manageToken: string) =>
  prisma.appointment
    .findFirstOrThrow({ where: { manageToken }, select: { clientId: true } })
    .then((a) => a.clientId);
const clientsCarrying = (where: { phone?: string; email?: string }) =>
  prisma.client.count({ where: { shopId, archivedAt: null, ...where } });

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.DRY_RUN = "true";
  __resetEnvCacheForTests();
  const owner = `applink-${randomToken(6)}@test.local`.toLowerCase();
  ownerEmails.push(owner);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: owner, password: "supersecret123", name: "D", smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Drick Style Cuts ${randomToken(4)}`, bookingUrl: "https://t.test", smsAttested: true });
  shopId = shop.body.id;
  slug = (
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 60 })
  ).body.slug;
  // Drick's: a card shop where the card is optional - Confirm books at once.
  await prisma.shop.update({
    where: { id: shopId },
    data: { publicPageEnabled: true, paymentsMode: "card_on_file", requireCardToBook: false },
  });
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drick" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (ownerEmails.length) await prisma.user.deleteMany({ where: { email: { in: ownerEmails } } });
  await prisma.$disconnect();
});

describe("booked from the app with an account already linked here", () => {
  it("the plain case: types the phone on file - lands on that record, shows", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: `tel:${phone}`, phone });
    const me = await account({ phone });
    const booked = await book({ phone, email: randomEmail("reg") }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect(await clientOf(booked.body.manageToken)).toBe(rec.id);
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("(b) signed in by phone, types only an email - lands on their record, nothing typed written to it", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: `tel:${phone}`, phone });
    const me = await account({ phone });
    const typedEmail = randomEmail("b");
    const booked = await book({ email: typedEmail }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect(await clientOf(booked.body.manageToken)).toBe(rec.id);
    // No second record for the typed email, and the record keeps what it had.
    expect(await clientsCarrying({ email: typedEmail })).toBe(0);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: rec.id } })).email).toBeNull();
    // The booking row keeps what was typed, so its confirmation reaches them.
    const appt = await prisma.appointment.findFirstOrThrow({ where: { manageToken: booked.body.manageToken } });
    expect(appt.email).toBe(typedEmail);
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("(b) types a different phone - still their record", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: `tel:${phone}`, phone });
    const me = await account({ phone });
    const other = randomPhone();
    const booked = await book({ phone: other, email: randomEmail("b3") }, await handoffFromStorefront(me.token), { smsConsent: true });
    expect(booked.status).toBe(201);
    expect(await clientOf(booked.body.manageToken)).toBe(rec.id);
    expect(await clientsCarrying({ phone: other })).toBe(0);
    // Consent was given for the OTHER number - it is not consent for theirs.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: rec.id } })).smsConsentAt).toBeNull();
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("(a) their record carries the phone under another key (the receptionist's bare E.164) - no duplicate, still shown", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: phone, phone });
    const me = await account({ phone });
    const booked = await book({ phone, email: randomEmail("a") }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect(await clientOf(booked.body.manageToken)).toBe(rec.id);
    expect(await clientsCarrying({ phone })).toBe(1);
    const h = await home(me.token);
    expect(h.ambiguous).toEqual([]);
    expect(h.next).not.toBeNull();
  });

  it("(a) their record is keyed by email and later got the phone (Acuity) - no duplicate", async () => {
    const phone = randomPhone();
    const email = randomEmail("acuity");
    const rec = await shopRecord({ key: `mail:${email}`, phone, email });
    const me = await account({ phone });
    const booked = await book({ phone, email }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(201);
    expect(await clientOf(booked.body.manageToken)).toBe(rec.id);
    expect(await clientsCarrying({ phone })).toBe(1);
    const h = await home(me.token);
    expect(h.ambiguous).toEqual([]);
    expect(h.next).not.toBeNull();
  });

  it("joined in the app with an email, then booked with phone + email - one record, shown", async () => {
    const email = randomEmail("joiner");
    const me = await account({ email });
    const joined = await request(app)
      .post("/api/me/shops/join")
      .set("Authorization", `Bearer ${me.token}`)
      .send({ handle: slug, firstName: "Dre", lastName: "Client" });
    expect(joined.body.status).toBe("joined");
    const booked = await book({ phone: randomPhone(), email }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect(await clientsCarrying({ email })).toBe(1);
    const h = await home(me.token);
    expect(h.ambiguous).toEqual([]);
    expect(h.next).not.toBeNull();
  });

  it("(c) linked by email; an older phone-only record holds the phone typed - their record, and the other is untouched", async () => {
    const phone = randomPhone();
    const email = randomEmail("c");
    const mine = await shopRecord({ key: `mail:${email}`, email });
    const phoneOnly = await shopRecord({ key: `tel:${phone}`, phone });
    const me = await account({ email });
    const booked = await book({ phone, email }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(201);
    expect(await clientOf(booked.body.manageToken)).toBe(mine.id);
    // #628: the phone-only record gets no email it never had, and no booking.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: phoneOnly.id } })).email).toBeNull();
    expect(await prisma.appointment.count({ where: { clientId: phoneOnly.id } })).toBe(0);
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("a standing appointment lands on their record too", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: phone, phone });
    const me = await account({ phone });
    const booked = await book(
      { phone, email: randomEmail("weekly") },
      await handoffFromStorefront(me.token),
      { recurrence: { interval: 1, count: 2 } },
    );
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect(await prisma.appointment.count({ where: { clientId: rec.id } })).toBe(2);
    expect(await clientsCarrying({ phone })).toBe(1);
    expect((await home(me.token)).upcomingCount).toBe(2);
  });
});

describe("booked from the app with no record linked here yet (a saved shop)", () => {
  it("the plain case: a fresh phone account types its own phone", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    const booked = await book({ phone, email: randomEmail("fresh") }, await handoffFromSavedShop(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("(b) a fresh phone account types only an email - the new record also carries the verified phone", async () => {
    const phone = randomPhone();
    const me = await account({ phone });
    const typedEmail = randomEmail("b2");
    const booked = await book({ email: typedEmail }, await handoffFromSavedShop(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    const rec = await prisma.client.findUniqueOrThrow({ where: { id: (await clientOf(booked.body.manageToken))! } });
    expect({ phone: rec.phone, email: rec.email }).toEqual({ phone, email: typedEmail });
    // ...but the BOOKING keeps what was typed: no text to a number they left blank.
    const appt = await prisma.appointment.findFirstOrThrow({ where: { manageToken: booked.body.manageToken } });
    expect(appt.phone).toBeNull();
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("(d) an archived record holds their key - it gives the key up, keeps its history, stays archived", async () => {
    const phone = randomPhone();
    const archived = await shopRecord({ key: `tel:${phone}`, phone, archived: true });
    const me = await account({ phone });
    const booked = await book({ phone, email: randomEmail("d") }, await handoffFromSavedShop(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: true });
    expect(await clientOf(booked.body.manageToken)).not.toBe(archived.id);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: archived.id } });
    expect(after.archivedAt).not.toBeNull();
    expect(after.acuityClientKey).toBe(`archived:${archived.id}`);
    expect((await home(me.token)).next).not.toBeNull();
  });

  it("(c) signed in by email, types a phone only an older record holds: lands there as typed, and is NOT opened to them", async () => {
    const phone = randomPhone();
    const email = randomEmail("c2");
    const phoneOnly = await shopRecord({ key: `tel:${phone}`, phone });
    const me = await account({ email });
    const booked = await book({ phone, email }, await handoffFromSavedShop(me.token));
    expect(booked.status).toBe(201);
    // Proving an email is not proving that phone: no link, no email filled
    // (#628), and the page is told so it can say how to fix it.
    expect(booked.body.inApp).toEqual({ shown: false });
    expect(await clientOf(booked.body.manageToken)).toBe(phoneOnly.id);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: phoneOnly.id } })).email).toBeNull();
    expect(await prisma.customerClientLink.count({ where: { accountId: me.id } })).toBe(0);
    expect((await home(me.token)).next).toBeNull();

    // The way out the app already has: add (verify) that number in Profile.
    await prisma.customerAccount.update({
      where: { id: me.id },
      data: { phoneE164: phone, phoneVerifiedAt: new Date() },
    });
    expect((await home(me.token)).next).not.toBeNull();
  });
});

describe("what a handoff can never do", () => {
  it("a stranger's email account typing a regular's phone gets nothing of theirs (#628 holds in the app)", async () => {
    const phone = randomPhone();
    const victim = await shopRecord({ key: `tel:${phone}`, phone });
    const attacker = await account({ email: randomEmail("mallory") });
    const booked = await book({ phone, email: randomEmail("typed") }, await handoffFromSavedShop(attacker.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: false });
    // Neither the typed email nor the attacker's own VERIFIED one lands on the regular's record.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: victim.id } })).email).toBeNull();
    const h = await home(attacker.token);
    expect(h.shops).toEqual([]);
    expect(h.next).toBeNull();
    expect(await prisma.customerClientLink.count({ where: { clientId: victim.id, status: "active" } })).toBe(0);
  });

  it("does not open a record shared with someone else: a second record on the contact stays unlinked", async () => {
    const phone = randomPhone();
    await shopRecord({ key: `tel:${phone}`, phone });
    await shopRecord({ key: phone, phone });
    const me = await account({ phone });
    expect((await home(me.token)).ambiguous).toHaveLength(1);
    // No link here, so no storefront: the page is reached as a saved shop.
    const booked = await book({ phone, email: randomEmail("shared") }, await handoffFromSavedShop(me.token));
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toEqual({ shown: false });
    expect((await home(me.token)).shops).toEqual([]);
  });

  it("never fills in a verified contact that would point the booking at a record the account was NOT given", async () => {
    // The account's phone is on two records here, so neither is opened to it.
    // It types only an email. Filling the blank phone with the verified one
    // would turn the key into tel:<phone> and land the booking on one of those
    // records - a record the identity rules just declined to give them.
    const phone = randomPhone();
    const one = await shopRecord({ key: `tel:${phone}`, phone });
    const two = await shopRecord({ key: phone, phone });
    const me = await account({ phone });
    const booked = await book({ email: randomEmail("blank") }, await handoffFromSavedShop(me.token));
    expect(booked.status).toBe(201);
    expect([one.id, two.id]).not.toContain(await clientOf(booked.body.manageToken));
    expect(await clientsCarrying({ phone })).toBe(2);
  });

  it("a forged, expired, other-shop or signed-out handoff books exactly as the page always has", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: phone, phone });
    const me = await account({ phone });
    const real = await handoffFromStorefront(me.token);
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      `${real.slice(0, -4)}AAAA`,
      mintBookingHandoff({ accountId: me.id, shopId, tokenVersion: 0 }, now - 5 * 3600),
      mintBookingHandoff({ accountId: me.id, shopId: "some-other-shop", tokenVersion: 0 }, now),
      mintBookingHandoff({ accountId: me.id, shopId, tokenVersion: 7 }, now),
    ];
    for (const handoff of bad) {
      const booked = await book({ email: randomEmail("bad") }, handoff);
      expect(booked.status).toBe(201);
      expect(booked.body.inApp).toBeUndefined();
      expect(await clientOf(booked.body.manageToken)).not.toBe(rec.id);
    }
  });

  it("without a handoff the page is unchanged: the typed contact decides", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: `tel:${phone}`, phone });
    await account({ phone });
    const typedEmail = randomEmail("anon");
    const booked = await book({ email: typedEmail });
    expect(booked.status).toBe(201);
    expect(booked.body.inApp).toBeUndefined();
    expect(await clientOf(booked.body.manageToken)).not.toBe(rec.id);
    expect(await clientsCarrying({ email: typedEmail })).toBe(1);
  });

  it("a client the shop blocked is refused on their own record, whatever they type", async () => {
    const phone = randomPhone();
    const rec = await shopRecord({ key: phone, phone });
    await prisma.client.update({ where: { id: rec.id }, data: { bookingBlockedAt: new Date() } });
    const me = await account({ phone });
    const booked = await book({ email: randomEmail("blocked") }, await handoffFromStorefront(me.token));
    expect(booked.status).toBe(403);
    expect(booked.body.code).toBe("CONTACT_SHOP");
  });
});
