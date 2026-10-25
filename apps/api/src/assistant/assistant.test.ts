import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type Prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { mintCustomerSession } from "../auth/customerSession.js";
import { __resetAssistantBudgetForTests } from "../routes/assistantChat.js";

/**
 * 🔴 THE BOOKING CHAT: menu + server rules, no model. Driven through the real
 * routes against a fixture shop, as a signed-in customer would: what the
 * person reads is asserted, and what was SAVED is read back from the database.
 */

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let staff2Id: string;
const ownerEmail = `asst-${randomToken(6)}@test.local`.toLowerCase();
const accountIds = new Set<string>();
const SHOP_NAME = "Fixture Cuts";

// ── fixture ──────────────────────────────────────────────────────────────
function futureDay(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}
/** How a person types a day: "Nov 2". */
const spoken = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function randomPhone(): string {
  return `+1628${200 + Math.floor(Math.random() * 700)}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
}
async function customer(opts: { phone?: string; clients?: number; firstName?: string; email?: string; atShop?: string } = {}) {
  const phone = opts.phone ?? randomPhone();
  const acct = await prisma.customerAccount.create({ data: { phoneE164: phone, phoneVerifiedAt: new Date(), firstName: opts.firstName ?? "Pat" } });
  accountIds.add(acct.id);
  const clients = [];
  for (let i = 0; i < (opts.clients ?? 1); i++) {
    clients.push(
      await prisma.client.create({
        data: {
          shopId: opts.atShop ?? shopId,
          acuityClientKey: `test:${randomToken(8)}`,
          magicToken: randomToken(),
          firstName: opts.firstName ?? `Pat${i}`,
          lastName: "Fixture",
          phone,
          email: opts.email ?? null,
        },
      }),
    );
  }
  return { token: mintCustomerSession(acct.id, 0), phone, clientId: clients[0]?.id ?? null };
}
const route = (s: string, kind: "turn" | "confirm") => `/api/assistant-chat/c/${s}/${kind}`;
const say = (token: string, text: string, recent?: string[], at = slug) =>
  request(app).post(route(at, "turn")).set("Authorization", `Bearer ${token}`).send({ text, ...(recent ? { recent } : {}) });
const tap = (token: string, pick: string, at = slug) => request(app).post(route(at, "turn")).set("Authorization", `Bearer ${token}`).send({ pick });
const nav = (token: string, n: string, at = slug) => request(app).post(route(at, "turn")).set("Authorization", `Bearer ${token}`).send({ nav: n });
const confirm = (token: string, t: string, at = slug) => request(app).post(route(at, "confirm")).set("Authorization", `Bearer ${token}`).send({ token: t });

beforeAll(async () => {
  process.env.ASSISTANT_CHAT_ENABLED = "true";
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();
  const signup = await request(app).post("/api/auth/signup").send({ email: ownerEmail, password: "supersecret123", name: "Asst Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  shopId = (await request(app).post("/api/shops").set("Cookie", cookie).send({ name: SHOP_NAME, bookingUrl: "https://book.test", smsAttested: true })).body.id;
  slug = (await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })).body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drew" })).body.id;
  staff2Id = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name: "Skin Fade", durationMin: 30, price: 40, staffIds: [staffId, staff2Id] });
  await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name: "Beard Trim", durationMin: 15, price: 20, staffIds: [staffId] });
  for (const id of [staffId, staff2Id]) {
    await request(app)
      .put(`/api/booking/staff/${id}/availability`)
      .set("Cookie", cookie)
      .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  }
  await prisma.shop.update({ where: { id: shopId }, data: { compAccess: true } });
});

beforeEach(() => {
  __resetAssistantBudgetForTests();
});

afterAll(async () => {
  for (const k of ["ASSISTANT_CHAT_ENABLED", "CUSTOMER_ACCOUNTS_ENABLED"]) delete process.env[k];
  __resetEnvCacheForTests();
  await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  for (const email of [ownerEmail, otherOwnerEmail]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

/** Type a request for openings on a fixed future day; return the slot buttons. */
async function openingsOn(token: string, day: string, service = "skin fade") {
  const r = await say(token, `any ${service} on ${spoken(day)}?`);
  expect(r.status).toBe(200);
  expect(r.body.action).toBe("find_openings");
  return r.body as { via: string; text: string; choices: Array<{ label: string; pick: string }> };
}

// ── tests ────────────────────────────────────────────────────────────────

describe("dark by default", () => {
  it("every route answers 404 while ASSISTANT_CHAT_ENABLED is off", async () => {
    process.env.ASSISTANT_CHAT_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      const c = await customer();
      expect((await request(app).get("/api/assistant-chat/status")).status).toBe(404);
      expect((await say(c.token, "hi")).status).toBe(404);
      expect((await nav(c.token, "book")).status).toBe(404);
      expect((await confirm(c.token, "x".repeat(32))).status).toBe(404);
    } finally {
      process.env.ASSISTANT_CHAT_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });

  it("on: the status says so, and nothing about any shop or person", async () => {
    const r = await request(app).get("/api/assistant-chat/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true });
  });
});

describe("customer: typed or tapped, the server answers", () => {
  it("find openings: real times as signed buttons, each naming day, time, zone, barber and price", async () => {
    const c = await customer();
    const r = await openingsOn(c.token, futureDay(3));
    expect(r.via).toBe("rules");
    expect(r.text).toBe(`Open times for Skin Fade at ${SHOP_NAME}:`);
    expect(r.choices.length).toBeGreaterThan(0);
    expect(r.choices[0]!.label).toMatch(/^\w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M UTC · (Drew|Sam) · \$40$/);
    // No ids in anything the person reads.
    expect(JSON.stringify(r.text) + r.choices.map((x) => x.label).join()).not.toMatch(/c[a-z0-9]{20,}/);
  });

  it("🔴 book: the tap holds and previews; only the confirm books; a retry books nothing twice", async () => {
    const c = await customer();
    const day = futureDay(4);
    const { choices } = await openingsOn(c.token, day);
    const preview = await tap(c.token, choices[0]!.pick);
    expect(preview.body.confirm.summary).toMatch(new RegExp(`^Book Skin Fade with (Drew|Sam) at ${SHOP_NAME}, .* UTC, \\$40\\?$`));
    const held = await prisma.appointment.findMany({ where: { shopId, clientId: c.clientId! } });
    expect(held).toHaveLength(1);
    expect(held[0]!.status).toBe("PENDING"); // a hold, not a booking

    const first = await confirm(c.token, preview.body.confirm.token);
    expect(first.body).toMatchObject({ ok: true });
    expect(first.body.text).toMatch(new RegExp(`^Booked: Skin Fade with (Drew|Sam) at ${SHOP_NAME}, .* UTC, \\$40\\.$`));
    const again = await confirm(c.token, preview.body.confirm.token);
    expect(again.body).toMatchObject({ ok: true, replay: true });
    const rows = await prisma.appointment.findMany({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
    expect(rows).toHaveLength(1);
  });

  it("🔴 two taps on one confirm at the same instant book once", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(5));
    const preview = await tap(c.token, choices[1]!.pick);
    const [a, b] = await Promise.all([confirm(c.token, preview.body.confirm.token), confirm(c.token, preview.body.confirm.token)]);
    expect([a.body.ok, b.body.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(1);
  });

  it("🔴 conflicting: two people, one time - the second is told it's taken, the first books", async () => {
    const a = await customer();
    const b = await customer();
    const day = futureDay(6);
    const pickA = (await openingsOn(a.token, day)).choices[0]!;
    const pickB = (await openingsOn(b.token, day)).choices.find((x) => x.label === pickA.label)!;
    const prevA = await tap(a.token, pickA.pick);
    expect(prevA.body.confirm).toBeTruthy();
    const prevB = await tap(b.token, pickB.pick);
    expect(prevB.body.confirm).toBeUndefined();
    expect(prevB.body.text).toMatch(/just taken/);
    expect((await confirm(a.token, prevA.body.confirm.token)).body.ok).toBe(true);
  });

  // The double-booking guard itself is the receptionist's slot lock,
  // race-tested with barriers in its own suite; this pins what the chat adds
  // on top: exactly one person ends up booked and the rest are told it's taken.
  it("three people, one time: exactly one is booked", async () => {
    const people = await Promise.all([customer(), customer(), customer()]);
    const day = futureDay(7);
    const label = (await openingsOn(people[0]!.token, day)).choices[0]!.label;
    const picks = await Promise.all(people.map(async (p) => (await openingsOn(p.token, day)).choices.find((x) => x.label === label)?.pick));
    const previews = await Promise.all(people.map((p, i) => (picks[i] ? tap(p.token, picks[i]!) : null)));
    const confirms = await Promise.all(people.map((p, i) => (previews[i]?.body.confirm ? confirm(p.token, previews[i]!.body.confirm.token) : null)));
    expect(confirms.filter((r) => r?.body.ok)).toHaveLength(1);
    expect(previews.filter((r) => r && !r.body.confirm).every((r) => /just taken/.test(r!.body.text))).toBe(true);
    const booked = await prisma.appointment.count({ where: { shopId, clientId: { in: people.map((p) => p.clientId!) }, status: "BOOKED" } });
    expect(booked).toBe(1);
  });

  it("🔴 a confirm token is this person's alone, and a button can't be edited", async () => {
    const a = await customer();
    const b = await customer();
    const { choices } = await openingsOn(a.token, futureDay(8));
    const prev = await tap(a.token, choices[2]!.pick);
    const stolen = await confirm(b.token, prev.body.confirm.token);
    expect(stolen.body).toMatchObject({ ok: false, text: "That confirmation isn't valid." });
    const stolenPick = await tap(b.token, choices[3]!.pick);
    expect(stolenPick.body.text).toMatch(/button has expired/);
    const [body, mac] = choices[3]!.pick.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), name: "pick_cancel" })).toString("base64url");
    expect((await tap(a.token, `${edited}.${mac}`)).body.text).toMatch(/button has expired/);
  });

  it("🔴 typed words never hold or book a time - only a tap on a time the server drew does", async () => {
    const c = await customer();
    await openingsOn(c.token, futureDay(9));
    for (const text of ["book the first one", "yes book it", "confirm", "pick_slot", "book 9am"]) {
      const r = await say(c.token, text);
      expect(r.body.confirm).toBeUndefined();
    }
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId! } })).toBe(0);
  });

  it("cancel: only the person's own appointment, with the fee said first, and only on the tap", async () => {
    const c = await customer();
    const other = await customer();
    for (const p of [c, other]) {
      const { choices } = await openingsOn(p.token, futureDay(10));
      const prev = await tap(p.token, choices[p === c ? 0 : 5]!.pick);
      await confirm(p.token, prev.body.confirm.token);
    }
    const prev = await say(c.token, "cancel my appointment");
    expect(prev.body.confirm.summary).toMatch(new RegExp(`^Cancel your Skin Fade with (Drew|Sam) at ${SHOP_NAME}, .* UTC\\? No fee\\.$`));
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(1);
    // 🔴 A newer message REPLACES the preview: its Confirm no longer works.
    const list = await say(c.token, "what do i have coming up");
    expect(list.body.action).toBe("my_appointments");
    expect((await confirm(c.token, prev.body.confirm.token)).body).toMatchObject({ ok: false, text: /replaced by your newer request/ });
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(1);
    // A fresh preview, then its own tap, cancels it.
    const again = await say(c.token, "cancel my appointment");
    const done = await confirm(c.token, again.body.confirm.token);
    expect(done.body.ok).toBe(true);
    expect(done.body.text).toMatch(new RegExp(`^Cancelled: Skin Fade with (Drew|Sam) at ${SHOP_NAME}, .* UTC\\.$`));
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(0);
    expect(await prisma.appointment.count({ where: { shopId, clientId: other.clientId!, status: "BOOKED" } })).toBe(1);
  });

  it("reschedule: new times for that booking, previewed with from AND to, moved on the tap", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(11));
    await confirm(c.token, (await tap(c.token, choices[0]!.pick)).body.confirm.token);
    const day = futureDay(12);
    const options = await say(c.token, `move my skin fade to ${spoken(day)}`);
    expect(options.body.text).toMatch(/^Move your Skin Fade on .* UTC to:$/);
    const prev = await tap(c.token, options.body.choices[0].pick);
    expect(prev.body.confirm.summary).toMatch(new RegExp(`^Move your Skin Fade at ${SHOP_NAME} from .* UTC to .* UTC with (Drew|Sam), \\$40\\?$`));
    const done = await confirm(c.token, prev.body.confirm.token);
    expect(done.body.ok).toBe(true);
    expect(done.body.text).toMatch(new RegExp(`^Moved: Skin Fade with (Drew|Sam) at ${SHOP_NAME}, `));
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
    expect(appt.startsAt.toISOString().slice(0, 10)).toBe(day);
  });
});

/**
 * 🔴 WHAT THE PERSON SAW IS WHAT WAS SAVED. Read the preview's own words,
 * then read the saved row, and compare every figure: shop, service, barber,
 * day, time, zone and price. In a real zone, across a daylight-saving change.
 */
describe("🔴 the preview's words match the saved booking", () => {
  const SUMMARY = /^Book (.+) with (\w+) at (.+), (\w{3}), (\w{3}) (\d{1,2}), (\d{1,2}):(\d{2}) ([AP]M) (\w{3,4}), \$(\d+(?:\.\d\d)?)\?$/;
  const parts = (at: Date, timeZone: string) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
    return Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  };

  it.each([
    ["before the clocks change (PDT)", 4],
    ["after the clocks change (PST)", 18],
  ])("%s", async (_when, daysAhead) => {
    await prisma.shop.update({ where: { id: shopId }, data: { timezone: "America/Los_Angeles" } });
    try {
      const c = await customer();
      const day = futureDay(daysAhead);
      const { choices } = await openingsOn(c.token, day, "beard trim");
      const prev = await tap(c.token, choices[choices.length - 1]!.pick);
      const seen = SUMMARY.exec(prev.body.confirm.summary);
      expect(seen, prev.body.confirm.summary).not.toBeNull();
      const [, service, barber, shop, wd, mon, dd, hh, mm, ap, zone, price] = seen!;
      expect((await confirm(c.token, prev.body.confirm.token)).body.ok).toBe(true);

      const saved = await prisma.appointment.findFirstOrThrow({
        where: { shopId, clientId: c.clientId!, status: "BOOKED" },
        select: { startsAt: true, priceAtBooking: true, service: { select: { name: true } }, staff: { select: { name: true } }, shop: { select: { name: true, timezone: true } } },
      });
      const p = parts(saved.startsAt, saved.shop.timezone);
      expect({ service, barber, shop, wd, mon, dd, hh, mm, ap, zone, price: Number(price) }).toEqual({
        service: saved.service.name,
        barber: saved.staff.name,
        shop: saved.shop.name,
        wd: p.weekday,
        mon: p.month,
        dd: p.day,
        hh: p.hour,
        mm: p.minute,
        ap: p.dayPeriod,
        zone: p.timeZoneName,
        price: Number(saved.priceAtBooking),
      });
      // The zone is the real one for that day, not a fixed label.
      expect(zone).toMatch(/^P[DS]T$/);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });
    }
  });
});

describe("🔴 identity and boundaries", () => {
  it("shared phone (two records): browsing works, booking and cancelling are refused with the booking page", async () => {
    const c = await customer({ clients: 2 });
    const { choices } = await openingsOn(c.token, futureDay(13));
    expect(choices.length).toBeGreaterThan(0);
    const r = await tap(c.token, choices[0]!.pick);
    expect(r.body.confirm).toBeUndefined();
    expect(r.body.text).toMatch(/^More than one client record here matches your number/);
    expect(r.body.link?.url).toMatch(new RegExp(`/book/${slug}$`));
    expect(await prisma.appointment.count({ where: { shopId, phone: c.phone } })).toBe(0);
  });

  it("not on file at this shop: no booking from chat - the booking page instead", async () => {
    const acct = await prisma.customerAccount.create({ data: { phoneE164: randomPhone(), phoneVerifiedAt: new Date() } });
    accountIds.add(acct.id);
    const token = mintCustomerSession(acct.id, 0);
    const { choices } = await openingsOn(token, futureDay(14));
    const r = await tap(token, choices[0]!.pick);
    expect(r.body.confirm).toBeUndefined();
    expect(r.body.text).toMatch(/first visit on the booking page/);
    // The service and barber they picked come pre-selected - never the time.
    const url = new URL(r.body.link!.url);
    expect(url.pathname).toBe(`/book/${slug}`);
    expect(url.searchParams.get("service")).toBeTruthy();
    expect([staffId, staff2Id]).toContain(url.searchParams.get("staff"));
    expect([...url.searchParams.keys()].sort()).toEqual(["service", "staff"]);
  });

  it("not on file: told up front, before choosing a service, day or time", async () => {
    const acct = await prisma.customerAccount.create({ data: { phoneE164: randomPhone(), phoneVerifiedAt: new Date() } });
    accountIds.add(acct.id);
    const r = await nav(mintCustomerSession(acct.id, 0), "book");
    expect(r.body.action).toBe("book_start");
    expect(r.body.text).toMatch(/first visit on the booking page/);
    expect(r.body.choices).toEqual([]);
    expect(r.body.link?.url).toMatch(new RegExp(`/book/${slug}$`));
  });

  it.each([
    ["deposit", { paymentsMode: "deposit" }],
    ["pay in full", { paymentsMode: "ahead" }],
    ["card required to book", { paymentsMode: "card_on_file", requireCardToBook: true }],
  ] as const)("🔴 checkout handoff (%s): no hold, no booking, a link to the booking page's checkout", async (_mode, data) => {
    await prisma.shop.update({ where: { id: shopId }, data });
    try {
      const c = await customer();
      const { choices } = await openingsOn(c.token, futureDay(15));
      const r = await tap(c.token, choices[0]!.pick);
      expect(r.body.confirm).toBeUndefined();
      expect(r.body.text).toBe("This shop takes payment when you book, so finish on the booking page.");
      expect(r.body.link).toEqual({ label: "Open the booking page", url: expect.stringMatching(new RegExp(`/book/${slug}\\?service=[^&]+&staff=[^&]+$`)) });
      expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId! } })).toBe(0);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { paymentsMode: "off", requireCardToBook: false } });
    }
  });

  it("card on file but not required: books from chat (the booking page doesn't require one either)", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { paymentsMode: "card_on_file", requireCardToBook: false } });
    try {
      const c = await customer();
      const { choices } = await openingsOn(c.token, futureDay(16));
      const r = await tap(c.token, choices[0]!.pick);
      expect(r.body.confirm).toBeTruthy();
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { paymentsMode: "off" } });
    }
  });

  it("🔴 customers don't share one rate-limit bucket (they all arrive from the web server's address)", async () => {
    // Mounted under dashboardLimiter (cookie, else IP), every customer's
    // bearer-only call would land in ONE bucket. Limits are lifted in tests,
    // so the KEY is what is pinned.
    const { assistantRateKey, __dashboardKeyForTests } = await import("../middleware/rateLimit.js");
    const req = (bearer: string) =>
      ({ ip: "10.0.0.5", cookies: {}, header: (h: string) => (h.toLowerCase() === "authorization" ? `Bearer ${bearer}` : undefined) }) as never;
    const [a, b] = [await customer(), await customer()];
    expect(assistantRateKey(req(a.token))).not.toBe(assistantRateKey(req(b.token)));
    expect(assistantRateKey(req(a.token))).toBe(assistantRateKey(req(a.token)));
    expect(__dashboardKeyForTests(req(a.token))).toBe(__dashboardKeyForTests(req(b.token)));
    // And the token itself is never the key.
    expect(assistantRateKey(req(a.token))).not.toContain(a.token);
  });

  it("no session, or a bad one: 401 - and an owner's dashboard cookie is not a customer session", async () => {
    expect((await request(app).post(route(slug, "turn")).send({ text: "hi" })).status).toBe(401);
    expect((await request(app).post(route(slug, "turn")).set("Authorization", "Bearer not-a-session").send({ text: "hi" })).status).toBe(401);
    expect((await request(app).post(route(slug, "turn")).set("Cookie", cookie).send({ text: "hi" })).status).toBe(401);
  });

  it("an unknown shop: 404", async () => {
    const c = await customer();
    expect((await say(c.token, "hi", undefined, `no-such-shop-${randomToken(4).toLowerCase()}`)).status).toBe(404);
  });

  it("a body that isn't exactly one of text, pick or nav: 400", async () => {
    const c = await customer();
    const send = (body: unknown) => request(app).post(route(slug, "turn")).set("Authorization", `Bearer ${c.token}`).send(body as object);
    expect((await send({})).status).toBe(400);
    expect((await send({ text: "hi", nav: "book" })).status).toBe(400);
    expect((await send({ nav: "drop_tables" })).status).toBe(400);
    expect((await send({ text: "hi", clientId: "x" })).status).toBe(400);
  });
});

// ── 🔴 SHOP ISOLATION: one customer account, two shops ──────────────────

const otherOwnerEmail = `asst-b-${randomToken(6)}@test.local`.toLowerCase();

describe("🔴 shop isolation", () => {
  let slugB = "";
  let shopB = "";
  beforeAll(async () => {
    const signup = await request(app).post("/api/auth/signup").send({ email: otherOwnerEmail, password: "supersecret123", name: "Other Owner", smsAttested: true });
    const ck = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    shopB = (await request(app).post("/api/shops").set("Cookie", ck).send({ name: "Other Shop", bookingUrl: "https://other.test", smsAttested: true })).body.id;
    slugB = (await request(app).patch("/api/shops/me").set("Cookie", ck).send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })).body.slug;
    const s = (await request(app).post("/api/booking/staff").set("Cookie", ck).send({ name: "Lee" })).body.id;
    await request(app).post("/api/booking/services").set("Cookie", ck).send({ name: "Skin Fade", durationMin: 30, price: 55, staffIds: [s] });
    await request(app)
      .put(`/api/booking/staff/${s}/availability`)
      .set("Cookie", ck)
      .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
    await prisma.shop.update({ where: { id: shopB }, data: { compAccess: true } });
  });

  it("a booking at shop A is invisible at shop B, and A's buttons and confirmations do nothing there", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(17));
    const prev = await tap(c.token, choices[0]!.pick);
    // At shop B: no record of this person, nothing of shop A's shown.
    const mine = await say(c.token, "what do i have coming up", undefined, slugB);
    expect(mine.body.text).toBe("I don't have you on file at this shop yet, so there's nothing to show.");
    expect(mine.body.choices).toEqual([]);
    // Shop A's button at shop B: refused like a forged one.
    expect((await tap(c.token, choices[1]!.pick, slugB)).body.text).toMatch(/button has expired/);
    // Shop A's confirmation at shop B: confirms nothing.
    expect((await confirm(c.token, prev.body.confirm.token, slugB)).body).toMatchObject({ ok: false, text: "That confirmation isn't valid." });
    expect(await prisma.appointment.count({ where: { shopId: shopB } })).toBe(0);
    // ...and it still works at shop A, once.
    expect((await confirm(c.token, prev.body.confirm.token)).body.ok).toBe(true);
  });

  it("the same person at both shops: each shop's chat sees and changes only its own booking", async () => {
    const phone = randomPhone();
    const a = await customer({ phone });
    // The same verified phone also on file at shop B (a second record, same account).
    await prisma.client.create({ data: { shopId: shopB, acuityClientKey: `test:${randomToken(8)}`, magicToken: randomToken(), firstName: "Pat", lastName: "Fixture", phone } });
    const day = futureDay(18);
    await confirm(a.token, (await tap(a.token, (await openingsOn(a.token, day)).choices[0]!.pick)).body.confirm.token);
    const atB = await say(a.token, `any skin fade on ${spoken(day)}?`, undefined, slugB);
    expect(atB.body.text).toBe("Open times for Skin Fade at Other Shop:");
    await confirm(a.token, (await tap(a.token, atB.body.choices[0].pick, slugB)).body.confirm.token, slugB);
    const listA = (await say(a.token, "what do i have coming up")).body.text as string;
    const listB = (await say(a.token, "what do i have coming up", undefined, slugB)).body.text as string;
    expect(listA.split("\n")).toHaveLength(1);
    expect(listB.split("\n")).toHaveLength(1);
    expect(listB).toMatch(/with Lee$/);
    // Cancelling at B touches only B.
    const prev = await say(a.token, "cancel my appointment", undefined, slugB);
    expect(prev.body.confirm.summary).toMatch(/at Other Shop/);
    expect((await confirm(a.token, prev.body.confirm.token, slugB)).body.ok).toBe(true);
    expect(await prisma.appointment.count({ where: { shopId, clientId: a.clientId!, status: "BOOKED" } })).toBe(1);
    expect(await prisma.appointment.count({ where: { shopId: shopB, status: "BOOKED" } })).toBe(0);
  });
});

// ── 🔴 CONFIRMATIONS ARE DURABLE, BOUND AND RE-CHECKED ──────────────────

describe("🔴 a confirmation runs once - across instances, restarts and lost answers", () => {
  let appB: Express;
  const emails: Array<{ to: string; subject: string; key?: string }> = [];
  beforeAll(async () => {
    // A SECOND API instance on the same database: what a scale-out or a
    // restart (old process gone, new one up) looks like to a confirm token.
    const { createApp } = await import("../app.js");
    appB = createApp();
    const { __setSendEmailForTests } = await import("../messaging/email.js");
    __setSendEmailForTests(async (input) => {
      emails.push({ to: input.to, subject: input.subject, key: input.idempotencyKey });
      return { status: "sent", id: `em_${emails.length}` };
    });
    const { armBackgroundWorkTracking } = await import("../backgroundWork.js");
    armBackgroundWorkTracking();
  });
  afterAll(async () => {
    const { __setSendEmailForTests } = await import("../messaging/email.js");
    __setSendEmailForTests(undefined);
  });
  const confirmOn = (a: Express, token: string, t: string) => request(a).post(route(slug, "confirm")).set("Authorization", `Bearer ${token}`).send({ token: t });
  const settle = async () => (await import("../backgroundWork.js")).settleBackgroundWork();
  const rowFor = async (t: string) => prisma.assistantConfirmation.findUniqueOrThrow({ where: { id: (await import("./confirm.js")).confirmId(t) } });

  it("the token is never stored - only its hash", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(19));
    const t = (await tap(c.token, choices[0]!.pick)).body.confirm.token as string;
    expect(await prisma.assistantConfirmation.findUnique({ where: { id: t } })).toBeNull();
    const row = await rowFor(t);
    expect(row).toMatchObject({ action: "book", status: "pending" });
    expect(row.actor).toMatch(/^c:/);
  });

  it("🔴 two API instances confirming one token at the same moment book once (row-lock barrier)", async () => {
    const { raceBehindRowLock, winners } = await import("../testing/raceBarrier.js");
    const { confirmId } = await import("./confirm.js");
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(20));
    const t = (await tap(c.token, choices[0]!.pick)).body.confirm.token as string;
    const { results, settledEarly } = await raceBehindRowLock("AssistantConfirmation", confirmId(t), [() => confirmOn(app, c.token, t), () => confirmOn(appB, c.token, t)]);
    expect(settledEarly).toBe(0); // both really queued on the confirmation row
    const bodies = winners(results).map((r) => r.body);
    expect(bodies.filter((b) => b.ok === true)).toHaveLength(1);
    expect(bodies.filter((b) => b.pending === true)).toHaveLength(1);
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(1);
    // The one that was told "still working" gets the real answer on its retry.
    const later = await confirmOn(appB, c.token, t);
    expect(later.body).toMatchObject({ ok: true, replay: true });
  });

  it("🔴 an instance died mid-run BEFORE booking: the next tap (other instance) books it, once", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(21));
    const t = (await tap(c.token, choices[0]!.pick)).body.confirm.token as string;
    const { confirmId, STALE_RUN_MS } = await import("./confirm.js");
    await prisma.assistantConfirmation.update({ where: { id: confirmId(t) }, data: { status: "running", claimedAt: new Date(Date.now() - STALE_RUN_MS - 5000) } });
    const r = await confirmOn(appB, c.token, t);
    expect(r.body).toMatchObject({ ok: true });
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(1);
  });

  it("🔴 an instance died AFTER booking, before saving the answer: the retry reports it, books nothing more, emails once", async () => {
    const address = `asst-${randomToken(5)}@example.com`.toLowerCase();
    const c = await customer({ email: address });
    const { choices } = await openingsOn(c.token, futureDay(22));
    const t = (await tap(c.token, choices[0]!.pick)).body.confirm.token as string;
    expect((await confirmOn(app, c.token, t)).body.ok).toBe(true);
    await settle();
    // Rewind the row to "running, no answer" - exactly what a crash leaves.
    const { confirmId, STALE_RUN_MS } = await import("./confirm.js");
    await prisma.assistantConfirmation.update({
      where: { id: confirmId(t) },
      data: { status: "running", result: null as never, claimedAt: new Date(Date.now() - STALE_RUN_MS - 5000) },
    });
    const retry = await confirmOn(appB, c.token, t);
    await settle();
    expect(retry.body).toMatchObject({ ok: true });
    expect(retry.body.text).toMatch(/^Booked: Skin Fade/);
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: { in: ["BOOKED", "PENDING"] } } })).toBe(1);
    // The normal confirmation email went once, under its retry key.
    const mine = emails.filter((e) => e.to === address);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.key).toMatch(/^appt-confirmation:/);
  });

  it("🔴 the menu price changed after the preview: booked at the price that was held and shown - and the receipt says so", async () => {
    // The confirm used to compare against the LIST price, re-ask "now $25",
    // and the engine then booked the held $20.
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(23), "beard trim");
    const prev = await tap(c.token, choices[0]!.pick);
    expect(prev.body.confirm.summary).toMatch(/\$20\?$/);
    const svc = await prisma.service.findFirstOrThrow({ where: { shopId, name: "Beard Trim" } });
    await prisma.service.update({ where: { id: svc.id }, data: { price: 25 } });
    try {
      const r = await confirm(c.token, prev.body.confirm.token);
      expect(r.body.ok).toBe(true);
      expect(r.body.text).toMatch(new RegExp(`^Booked: Beard Trim with Drew at ${SHOP_NAME}, .*, \\$20\\.`));
      const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
      expect(Number(appt.priceAtBooking)).toBe(20);
    } finally {
      await prisma.service.update({ where: { id: svc.id }, data: { price: 20 } });
    }
  });

  it("🔴 the price the engine will write differs from the preview: an updated proposal, nothing booked until confirmed", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(28), "beard trim");
    const prev = await tap(c.token, choices[0]!.pick);
    const row = await rowFor(prev.body.confirm.token);
    // The hold's own price is what booking writes; make it differ from the preview.
    await prisma.appointment.update({ where: { id: String((row.args as Record<string, unknown>).hold_id) }, data: { priceAtBooking: 25 } });
    const r = await confirm(c.token, prev.body.confirm.token);
    expect(r.body.ok).toBe(false);
    expect(r.body.text).toMatch(/now \$25 \(it was \$20\)/);
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(0);
    // The old token is spent (superseded); the new one books at $25, and says $25.
    expect((await confirm(c.token, prev.body.confirm.token)).body.replay).toBe(true);
    const done = await confirm(c.token, r.body.confirm.token);
    expect(done.body.ok).toBe(true);
    expect(done.body.text).toMatch(/, \$25\.$/);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
    expect(Number(appt.priceAtBooking)).toBe(25);
  });

  it("the hold ran out while they decided: held again and asked again", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(24));
    const prev = await tap(c.token, choices[0]!.pick);
    const row = await rowFor(prev.body.confirm.token);
    await prisma.appointment.update({ where: { id: String((row.args as Record<string, unknown>).hold_id) }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    const r = await confirm(c.token, prev.body.confirm.token);
    expect(r.body.ok).toBe(false);
    expect(r.body.text).toMatch(/hold on that time ran out, so I held it again/);
    expect((await confirm(c.token, r.body.confirm.token)).body.ok).toBe(true);
  });

  it("🔴 the hold ran out and someone else booked the time: nothing booked, said plainly", async () => {
    const a = await customer();
    const b = await customer();
    const day = futureDay(25);
    const pickA = (await openingsOn(a.token, day)).choices[0]!;
    const prevA = await tap(a.token, pickA.pick);
    const rowA = await rowFor(prevA.body.confirm.token);
    await prisma.appointment.update({ where: { id: String((rowA.args as Record<string, unknown>).hold_id) }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    const pickB = (await openingsOn(b.token, day)).choices.find((x) => x.label === pickA.label)!;
    expect((await confirm(b.token, (await tap(b.token, pickB.pick)).body.confirm.token)).body.ok).toBe(true);
    const r = await confirm(a.token, prevA.body.confirm.token);
    expect(r.body).toMatchObject({ ok: false });
    expect(r.body.text).toMatch(/That time is gone now, so nothing was booked/);
    expect(await prisma.appointment.count({ where: { shopId, clientId: a.clientId!, status: "BOOKED" } })).toBe(0);
  });

  it("🔴 the appointment moved after a cancel preview: re-asked with the truth, not cancelled", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(26));
    await confirm(c.token, (await tap(c.token, choices[0]!.pick)).body.confirm.token);
    const prev = await say(c.token, "cancel it");
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { startsAt: new Date(appt.startsAt.getTime() + 3600000), endsAt: new Date(appt.endsAt.getTime() + 3600000) },
    });
    const r = await confirm(c.token, prev.body.confirm.token);
    expect(r.body.ok).toBe(false);
    expect(r.body.text).toMatch(/^Something changed since you asked\. Cancel your Skin Fade with/);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("BOOKED");
  });

  it("an expired confirmation confirms nothing", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(27));
    const t = (await tap(c.token, choices[0]!.pick)).body.confirm.token as string;
    const { confirmId } = await import("./confirm.js");
    await prisma.assistantConfirmation.update({ where: { id: confirmId(t) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await confirm(c.token, t);
    expect(r.body.text).toMatch(/timed out/);
    expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(0);
  });
});

// ── 🔴 CHANGING ONE'S MIND, ACROSS A WHOLE CONVERSATION ─────────────────

describe("🔴 a newer request replaces the open preview - on the server", () => {
  const bookedCount = (clientId: string) => prisma.appointment.count({ where: { shopId, clientId, status: "BOOKED" } });
  const holdsOf = (clientId: string) => prisma.appointment.count({ where: { shopId, clientId, status: "PENDING" } });

  it('"never mind" after a preview: dropped, the old Confirm refused, the held time let go', async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(30));
    const prev = await tap(c.token, choices[0]!.pick);
    expect(await holdsOf(c.clientId!)).toBe(1);
    const nm = await say(c.token, "never mind");
    expect(nm.body).toMatchObject({ action: "never_mind", text: "Okay, I dropped that. Nothing was changed." });
    expect(await holdsOf(c.clientId!)).toBe(0); // the time is free again
    const late = await confirm(c.token, prev.body.confirm.token);
    expect(late.body).toMatchObject({ ok: false, text: /replaced by your newer request/ });
    expect(await bookedCount(c.clientId!)).toBe(0);
  });

  it('"never mind" after it already went through: says so truthfully, offers the way back, undoes nothing', async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(31));
    expect((await confirm(c.token, (await tap(c.token, choices[0]!.pick)).body.confirm.token)).body.ok).toBe(true);
    const nm = await say(c.token, "actually nvm");
    expect(nm.body.text).toMatch(/^That already went through \(Book Skin Fade with .*\), so I haven't undone anything\. Do you want to cancel it\?$/);
    expect(nm.body.choices).toHaveLength(1);
    expect(nm.body.choices[0].label).toMatch(/^Cancel /);
    expect(await bookedCount(c.clientId!)).toBe(1);
  });

  it("changing the service: the Skin Fade preview is retired when they ask for a Beard Trim instead", async () => {
    const c = await customer();
    const day = futureDay(32);
    const ask = `any skin fade on ${spoken(day)}?`;
    const fade = await tap(c.token, (await openingsOn(c.token, day)).choices[0]!.pick);
    const beard = await say(c.token, "wait, a beard trim instead", [ask]);
    expect(beard.body.text).toBe(`Open times for Beard Trim at ${SHOP_NAME}:`);
    // ...on the day already said, carried over from the earlier message.
    expect(beard.body.choices[0].label).toMatch(new RegExp(`^\\w{3}, ${spoken(day)},`));
    expect(await holdsOf(c.clientId!)).toBe(0);
    expect((await confirm(c.token, fade.body.confirm.token)).body.ok).toBe(false);
    expect(await bookedCount(c.clientId!)).toBe(0);
  });

  it("🔴 two Wednesday bookings: asked which (both shown), then switching to the other one retires the first preview", async () => {
    const c = await customer();
    // Two bookings a week apart: same weekday.
    for (const d of [futureDay(35), futureDay(42)]) {
      const { choices } = await openingsOn(c.token, d);
      await confirm(c.token, (await tap(c.token, choices[0]!.pick)).body.confirm.token);
    }
    const weekday = new Date(`${futureDay(35)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
    const ask = await say(c.token, `cancel my ${weekday} appointment`);
    expect(ask.body.action).toBe("choose_appointment");
    expect(ask.body.confirm).toBeUndefined();
    expect(ask.body.choices).toHaveLength(2);
    for (const ch of ask.body.choices) expect(ch.label).toMatch(/UTC · Skin Fade with (Drew|Sam)$/);
    const first = await tap(c.token, ask.body.choices[0].pick);
    expect(first.body.confirm.summary).toMatch(/^Cancel your Skin Fade with /);
    // "No, the other one": a NEW preview for the second; the first is dead.
    const second = await tap(c.token, ask.body.choices[1].pick);
    expect((await confirm(c.token, first.body.confirm.token)).body.ok).toBe(false);
    expect((await confirm(c.token, second.body.confirm.token)).body.ok).toBe(true);
    expect(await bookedCount(c.clientId!)).toBe(1);
  });

  it("🔴 a stale Confirm racing a changed request: exactly one wins, and what is said matches what happened (row-lock barrier)", async () => {
    const { raceBehindRowLock, winners } = await import("../testing/raceBarrier.js");
    const { confirmId } = await import("./confirm.js");
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(33));
    const prev = await tap(c.token, choices[0]!.pick);
    const t = prev.body.confirm.token as string;
    const { results, settledEarly } = await raceBehindRowLock("AssistantConfirmation", confirmId(t), [() => confirm(c.token, t), () => say(c.token, "forget it")]);
    expect(settledEarly).toBe(0); // both really queued on the confirmation row
    const [conf, nm] = winners(results).map((r) => r.body);
    const booked = await bookedCount(c.clientId!);
    if (conf.ok) {
      // The tap won: it is booked, and "forget it" must not pretend otherwise.
      expect(booked).toBe(1);
      expect(nm.text).toMatch(/already went through/);
    } else {
      // The new request won: nothing booked, and the tap says it was replaced.
      expect(booked).toBe(0);
      expect(conf.text).toMatch(/replaced by your newer request/);
      expect(nm.text).toBe("Okay, I dropped that. Nothing was changed.");
    }
    expect(await holdsOf(c.clientId!)).toBe(0);
  });

  it("the menu: Book -> service -> day -> time -> preview, with no typing", async () => {
    const c = await customer();
    const start = await nav(c.token, "book");
    expect(start.body.via).toBe("button");
    const svc = start.body.choices.find((x: { label: string }) => x.label === "Beard Trim");
    const days = await tap(c.token, svc.pick);
    expect(days.body.text).toBe("Which day for your Beard Trim?");
    expect(days.body.choices.map((x: { label: string }) => x.label)).toContain("Later dates");
    const day = days.body.choices.find((x: { label: string }) => x.label === "Tomorrow");
    const times = await tap(c.token, day.pick);
    expect(times.body.text).toBe(`Open times for Beard Trim at ${SHOP_NAME}:`);
    const prev = await tap(c.token, times.body.choices[0].pick);
    expect(prev.body.confirm.summary).toMatch(new RegExp(`^Book Beard Trim with Drew at ${SHOP_NAME}, `));
    for (const n of ["appointments", "move", "cancel", "ask", "menu"]) expect((await nav(c.token, n)).status).toBe(200);
  });

  it('"Later dates" reaches weeks out, and stops at eight weeks', async () => {
    const c = await customer();
    let page = await tap(c.token, (await nav(c.token, "book")).body.choices.find((x: { label: string }) => x.label === "Skin Fade").pick);
    let pages = 1;
    for (;;) {
      const later = page.body.choices.find((x: { label: string }) => x.label === "Later dates");
      if (!later) break;
      page = await tap(c.token, later.pick);
      pages++;
    }
    expect(pages).toBe(8);
  });
});

/**
 * 🔴 READY TO SWITCH ON: one shop at a time, labelled as the chat, a moved
 * booking emails the new time, and the booking page's own rules - approval,
 * policy, required questions, a lapsed shop - are never booked around.
 */
describe("🔴 ready to switch on", () => {
  const emails: Array<{ to: string; subject: string; key?: string }> = [];
  beforeAll(async () => {
    const { __setSendEmailForTests } = await import("../messaging/email.js");
    __setSendEmailForTests(async (input) => {
      emails.push({ to: input.to, subject: input.subject, key: input.idempotencyKey });
      return { status: "sent", id: `em_ready_${emails.length}` };
    });
    const { armBackgroundWorkTracking } = await import("../backgroundWork.js");
    armBackgroundWorkTracking();
  });
  afterAll(async () => {
    const { __setSendEmailForTests } = await import("../messaging/email.js");
    __setSendEmailForTests(undefined);
  });
  const settle = async () => (await import("../backgroundWork.js")).settleBackgroundWork();
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    __resetEnvCacheForTests();
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetEnvCacheForTests();
    }
  };

  it("one shop only: ASSISTANT_CHAT_SHOP_IDS opens it there, and every other shop gets the same 404 as 'off'", async () => {
    const c = await customer();
    await withEnv({ ASSISTANT_CHAT_SHOP_IDS: shopId }, async () => {
      expect((await request(app).get(`/api/assistant-chat/c/${slug}/status`)).body).toEqual({ enabled: true });
      expect((await nav(c.token, "menu")).status).toBe(200);
      // A shop-less status can't say yes to "which shop?" - so it says no.
      expect((await request(app).get("/api/assistant-chat/status")).body).toEqual({ enabled: false });
    });
    await withEnv({ ASSISTANT_CHAT_SHOP_IDS: "some_other_shop" }, async () => {
      expect((await request(app).get(`/api/assistant-chat/c/${slug}/status`)).status).toBe(404);
      expect((await nav(c.token, "menu")).status).toBe(404);
      expect((await say(c.token, "hi")).status).toBe(404);
    });
    // The booking-page slug works as well as the id (it is what an operator can read).
    await withEnv({ ASSISTANT_CHAT_SHOP_IDS: `some_other_shop, ${slug}` }, async () => {
      expect((await request(app).get(`/api/assistant-chat/c/${slug}/status`)).body).toEqual({ enabled: true });
      expect((await nav(c.token, "menu")).status).toBe(200);
    });
    // Empty = every shop.
    expect((await request(app).get(`/api/assistant-chat/c/${slug}/status`)).body).toEqual({ enabled: true });
    expect((await request(app).get("/api/assistant-chat/c/no-such-shop-xyz/status")).status).toBe(404);
  });

  it("a chat booking - its hold and the booking - is labelled the chat's, not the SMS receptionist's", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(30));
    const preview = await tap(c.token, choices[0]!.pick);
    const hold = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "PENDING" } });
    expect(hold.bookedVia).toBe("assistant");
    expect((await confirm(c.token, preview.body.confirm.token)).body.ok).toBe(true);
    const booked = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
    expect(booked.id).toBe(hold.id); // the hold itself became the booking - found under the new label
    expect(booked.bookedVia).toBe("assistant");
  });

  it("🔴 a move from chat emails the NEW time (it used to send nothing)", async () => {
    const address = `asst-move-${randomToken(5)}@example.com`.toLowerCase();
    const c = await customer({ email: address });
    const { choices } = await openingsOn(c.token, futureDay(31));
    await confirm(c.token, (await tap(c.token, choices[0]!.pick)).body.confirm.token);
    await settle();
    expect(emails.filter((e) => e.to === address)).toHaveLength(1);
    const options = await say(c.token, `move my skin fade to ${spoken(futureDay(32))}`);
    const prev = await tap(c.token, options.body.choices[0].pick);
    expect((await confirm(c.token, prev.body.confirm.token)).body.ok).toBe(true);
    await settle();
    const mine = emails.filter((e) => e.to === address);
    expect(mine).toHaveLength(2);
    expect(mine[1]!.key).not.toBe(mine[0]!.key);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } });
    expect(appt.confirmationEmailSentAt).not.toBeNull();
  });

  it.each<[string, Prisma.ShopUpdateInput, RegExp]>([
    ["approves each booking", { requireBookingApproval: true }, /approves each booking itself/],
    ["has a policy to agree to", { bookingPolicyText: "Be on time.", bookingPolicyChecklist: ["I will arrive 5 minutes early"] }, /agree to its booking policy/],
  ])("🔴 a shop that %s: handed to the booking page up front and at the time - nothing held or booked", async (_why, data, said) => {
    await prisma.shop.update({ where: { id: shopId }, data });
    try {
      const c = await customer();
      const start = await nav(c.token, "book");
      expect(start.body.text).toMatch(said);
      expect(start.body.choices).toEqual([]);
      const { choices } = await openingsOn(c.token, futureDay(33));
      const r = await tap(c.token, choices[0]!.pick);
      expect(r.body.confirm).toBeUndefined();
      expect(r.body.text).toMatch(said);
      expect(r.body.link?.url).toMatch(/\?service=[^&]+&staff=[^&]+$/);
      expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId! } })).toBe(0);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { requireBookingApproval: false, bookingPolicyText: null, bookingPolicyChecklist: [] } });
    }
  });

  it("🔴 the shop switches on approval between the preview and the tap: nothing is booked", async () => {
    const c = await customer();
    const { choices } = await openingsOn(c.token, futureDay(34));
    const preview = await tap(c.token, choices[0]!.pick);
    expect(preview.body.confirm).toBeTruthy();
    await prisma.shop.update({ where: { id: shopId }, data: { requireBookingApproval: true } });
    try {
      const r = await confirm(c.token, preview.body.confirm.token);
      expect(r.body.ok).toBe(false);
      expect(r.body.text).toMatch(/^Nothing was booked\. This shop approves each booking itself/);
      expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId!, status: "BOOKED" } })).toBe(0);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { requireBookingApproval: false } });
    }
  });

  it("🔴 a service with a REQUIRED question: finished on the booking page, with that service chosen", async () => {
    const services = await prisma.service.findMany({ where: { shopId }, select: { id: true, name: true } });
    const fade = services.find((s) => s.name === "Skin Fade")!;
    const q = await prisma.bookingQuestion.create({ data: { shopId, serviceIds: [fade.id], label: "Any allergies?", required: true } });
    try {
      const c = await customer();
      const { choices } = await openingsOn(c.token, futureDay(35));
      const r = await tap(c.token, choices[0]!.pick);
      expect(r.body.confirm).toBeUndefined();
      expect(r.body.text).toMatch(/questions to answer first/);
      expect(new URL(r.body.link!.url).searchParams.get("service")).toBe(fade.id);
      expect(await prisma.appointment.count({ where: { shopId, clientId: c.clientId! } })).toBe(0);
      // An OPTIONAL question doesn't stop a chat booking - the page wouldn't either.
      await prisma.bookingQuestion.update({ where: { id: q.id }, data: { required: false } });
      expect((await tap(c.token, choices[0]!.pick)).body.confirm).toBeTruthy();
    } finally {
      await prisma.bookingQuestion.delete({ where: { id: q.id } });
    }
  });

  it("🔴 a lapsed shop takes no bookings from chat (as on its booking page)", async () => {
    const c = await customer();
    await prisma.shop.update({ where: { id: shopId }, data: { compAccess: false, subscriptionStatus: "canceled", trialEndsAt: new Date(Date.now() - 86_400_000) } });
    try {
      await withEnv({ STRIPE_SECRET_KEY: "sk_test_ready", STRIPE_PRICE_ID: "price_ready", STRIPE_WEBHOOK_SECRET: "whsec_ready" }, async () => {
        expect((await nav(c.token, "book")).body.text).toMatch(/isn't taking online bookings right now/);
        expect((await say(c.token, `any skin fade on ${spoken(futureDay(37))}?`)).body.text).toMatch(/isn't taking online bookings right now/);
      });
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { compAccess: true } });
    }
  });
});
