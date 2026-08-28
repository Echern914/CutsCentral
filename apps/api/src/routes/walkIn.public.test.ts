import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";

/**
 * The public kiosk + tracking surface from the OUTSIDE - through the app,
 * the limiters' mounting, and a deterministic test SMS transport that
 * captures every body (which is also how the tests get the six-digit code,
 * exactly the way a customer would).
 *
 * The heart of this suite is CONSTANCY: equivalent requests must be
 * byte-identical whether the phone is unknown, a known client, or already in
 * line - compared as full (status, body) pairs, not vibes.
 */

const app = createApp();
const emails: string[] = [];

let ownerCookie: string;
let shopId: string;
let kioskToken: string;
let chairA: string;
let serviceId: string;

/** Every SMS the API "sent", in order. */
let sent: SendMessageInput[] = [];
let phoneSeq = 0;

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(6000 + phoneSeq).padStart(4, "0")}`;
}

function lastSmsTo(phone: string): SendMessageInput | undefined {
  return [...sent].reverse().find((s) => s.to === phone);
}

function codeFor(phone: string): string {
  const body = lastSmsTo(phone)?.body ?? "";
  const m = /(\d{6})/.exec(body);
  expect(m, `no code SMS for phone`).toBeTruthy();
  return m![1]!;
}

function linkFor(phone: string): string {
  const body = lastSmsTo(phone)?.body ?? "";
  const m = /#t=([A-Za-z0-9_-]+)/.exec(body);
  expect(m, `no link SMS for phone`).toBeTruthy();
  return m![1]!;
}

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

const post = (path: string, body: unknown) =>
  request(app).post(path).send(body as object);

/** The whole happy flow for one phone; returns what the customer holds. */
async function fullCheckIn(phone: string, over: Record<string, unknown> = {}) {
  const ch = await post("/api/walk-in/kiosk/challenge", { token: kioskToken, phone });
  expect(ch.status).toBe(200);
  const v = await post("/api/walk-in/kiosk/verify", {
    token: kioskToken,
    phone,
    code: codeFor(phone),
  });
  expect(v.body.verified).toBe(true);
  const ci = await post("/api/walk-in/kiosk/check-in", {
    token: kioskToken,
    proof: v.body.proof,
    phone,
    firstName: "Cust",
    serviceIds: [serviceId],
    preferredStaffId: null,
    smsConsent: true,
    ...over,
  });
  return { verify: v, checkIn: ci, trackToken: linkFor(phone) };
}

beforeAll(async () => {
  process.env.WALK_IN_MODE_ENABLED = "true";
  process.env.DRY_RUN = "true";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `TEST${sent.length}`, status: "sent" };
    },
  });

  const owner = await signup("wp-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Kiosk Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC", walkInEnabled: true });

  chairA = (
    await request(app)
      .post("/api/booking/staff")
      .set("Cookie", ownerCookie)
      .send({ name: "Ava" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", ownerCookie)
      .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA] })
  ).body.id;

  const mint = await request(app)
    .post("/api/shops/me/walk-in-kiosk-token")
    .set("Cookie", ownerCookie);
  expect(mint.status).toBe(200);
  kioskToken = /#k=([A-Za-z0-9_-]+)/.exec(mint.body.url)![1]!;
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  delete process.env.WALK_IN_MODE_ENABLED;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const shops = await prisma.shop.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      await prisma.walkInEvent.deleteMany({
        where: { shopId: { in: shops.map((s) => s.id) } },
      });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("gates", () => {
  it("env flag off -> the whole surface 404s", async () => {
    process.env.WALK_IN_MODE_ENABLED = "false";
    __resetEnvCacheForTests();
    const res = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(res.status).toBe(404);
    process.env.WALK_IN_MODE_ENABLED = "true";
    __resetEnvCacheForTests();
  });

  it("shop toggle off and a bogus token are the SAME 404", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { walkInEnabled: false } });
    const disabled = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    await prisma.shop.update({ where: { id: shopId }, data: { walkInEnabled: true } });
    const bogus = await post("/api/walk-in/kiosk/resolve", { token: randomToken(32) });
    expect(disabled.status).toBe(404);
    expect(bogus.status).toBe(404);
    expect(disabled.body).toEqual(bogus.body);
  });

  it("not accepting -> resolve says so; challenge/check-in refuse honestly", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { walkInAcceptingNow: false },
    });
    const res = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(res.status).toBe(200);
    expect(res.body.acceptingNow).toBe(false);
    const ch = await post("/api/walk-in/kiosk/challenge", {
      token: kioskToken,
      phone: freshPhone(),
    });
    expect(ch.status).toBe(409);
    await prisma.shop.update({
      where: { id: shopId },
      data: { walkInAcceptingNow: true },
    });
  });

  it("🔴 resolve reports whether the shop can take a walk-in at all", async () => {
    // A kiosk pointed at a shop with no active services renders a selection
    // screen with nothing on it and a permanently disabled Next. The server
    // says so rather than leaving the tablet to look broken.
    const full = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(full.body.setupComplete).toBe(true);

    await prisma.service.updateMany({ where: { shopId }, data: { active: false } });
    const noServices = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(noServices.status).toBe(200); // still a normal answer, not an error
    expect(noServices.body.setupComplete).toBe(false);
    expect(noServices.body.services).toEqual([]);
    await prisma.service.updateMany({ where: { shopId }, data: { active: true } });

    // Staff is the other half, and the worse one: that flow COMPLETES and
    // creates an entry nobody can ever be assigned to.
    await prisma.staff.updateMany({ where: { shopId }, data: { active: false } });
    const noStaff = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(noStaff.body.setupComplete).toBe(false);
    await prisma.staff.updateMany({ where: { shopId }, data: { active: true } });

    const restored = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(restored.body.setupComplete).toBe(true);
  });

  it("rotating the kiosk token kills the old tablet URL", async () => {
    const old = kioskToken;
    const mint = await request(app)
      .post("/api/shops/me/walk-in-kiosk-token")
      .set("Cookie", ownerCookie);
    kioskToken = /#k=([A-Za-z0-9_-]+)/.exec(mint.body.url)![1]!;
    const res = await post("/api/walk-in/kiosk/resolve", { token: old });
    expect(res.status).toBe(404);
    const fresh = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    expect(fresh.status).toBe(200);
  });

  it("resolve exposes only what the public booking page already would", async () => {
    const res = await post("/api/walk-in/kiosk/resolve", { token: kioskToken });
    const flat = JSON.stringify(res.body);
    expect(res.body.staff[0]).toEqual({
      id: chairA,
      name: "Ava",
      imageUrl: null,
    });
    // No phones, no emails, no client anything, no queue names.
    expect(flat).not.toMatch(/phone|email|client|firstName/i);
  });
});

describe("anti-enumeration before verification", () => {
  it("challenge answers BYTE-IDENTICALLY for unknown, known-client, and already-in-line phones", async () => {
    const unknown = freshPhone();
    const known = freshPhone();
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: known,
        firstName: "Regular",
        phone: known,
        magicToken: randomToken(),
      },
    });
    const inLine = freshPhone();
    await fullCheckIn(inLine);
    sent = [];

    const answers = [];
    for (const phone of [unknown, known, inLine]) {
      const res = await post("/api/walk-in/kiosk/challenge", {
        token: kioskToken,
        phone,
      });
      answers.push({ status: res.status, body: res.body });
    }
    expect(answers[0]).toEqual({ status: 200, body: { ok: true } });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("verify failures are one uniform refusal, and reveal nothing on the way", async () => {
    const phone = freshPhone();
    await post("/api/walk-in/kiosk/challenge", { token: kioskToken, phone });
    const wrong = await post("/api/walk-in/kiosk/verify", {
      token: kioskToken,
      phone,
      code: "000000",
    });
    const neverIssued = await post("/api/walk-in/kiosk/verify", {
      token: kioskToken,
      phone: freshPhone(),
      code: "123456",
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toEqual({ ok: true, verified: false });
    expect(neverIssued.body).toEqual(wrong.body);
  });

  it("a code challenged at this shop cannot be verified through another shop's kiosk", async () => {
    const other = await signup("wp-other");
    await request(app)
      .post("/api/shops")
      .set("Cookie", other.cookie)
      .send({ name: "Other Kiosk", smsAttested: true });
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", other.cookie)
      .send({ walkInEnabled: true });
    const mint = await request(app)
      .post("/api/shops/me/walk-in-kiosk-token")
      .set("Cookie", other.cookie);
    const otherToken = /#k=([A-Za-z0-9_-]+)/.exec(mint.body.url)![1]!;

    const phone = freshPhone();
    await post("/api/walk-in/kiosk/challenge", { token: kioskToken, phone });
    const res = await post("/api/walk-in/kiosk/verify", {
      token: otherToken,
      phone,
      code: codeFor(phone),
    });
    expect(res.body).toEqual({ ok: true, verified: false });
  });
});

describe("check-in", () => {
  it("the full flow: code SMS, then a link SMS whose credential is fragment-only", async () => {
    const phone = freshPhone();
    const { verify, checkIn } = await fullCheckIn(phone);
    expect(verify.body.known).toBe(false);
    expect(checkIn.status).toBe(200);
    expect(checkIn.body).toEqual({ ok: true });
    const link = lastSmsTo(phone)!.body;
    expect(link).toContain("/line#t=");
    expect(link).not.toContain("?t=");
  });

  it("a verified RETURNING customer is greeted with their own first name - after possession, never before", async () => {
    const phone = freshPhone();
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: phone,
        firstName: "Marcus",
        phone,
        magicToken: randomToken(),
      },
    });
    await post("/api/walk-in/kiosk/challenge", { token: kioskToken, phone });
    const v = await post("/api/walk-in/kiosk/verify", {
      token: kioskToken,
      phone,
      code: codeFor(phone),
    });
    expect(v.body.known).toBe(true);
    expect(v.body.firstName).toBe("Marcus");
  });

  it("🔴 a duplicate check-in answers BYTE-IDENTICALLY and re-texts a ROTATED link", async () => {
    const phone = freshPhone();
    const first = await fullCheckIn(phone);
    const firstLink = first.trackToken;
    // Step past the resend cooldown so the second visit can get a fresh code
    // (the cooldown itself is pinned in walkInVerify.test.ts).
    await prisma.walkInPhoneCode.update({
      where: { shopId_phone: { shopId, phone } },
      data: { lastSentAt: new Date(Date.now() - 2 * 60 * 1000) },
    });
    const second = await fullCheckIn(phone);
    expect(second.checkIn.status).toBe(first.checkIn.status);
    expect(second.checkIn.body).toEqual(first.checkIn.body);
    expect(second.trackToken).not.toBe(firstLink);
    // Exactly one active entry, old link dead, new link live.
    expect(
      await prisma.walkInEntry.count({
        where: { shopId, phone, status: "WAITING" },
      }),
    ).toBe(1);
    const dead = await post("/api/walk-in/track/exchange", { token: firstLink });
    expect(dead.status).toBe(404);
    const live = await post("/api/walk-in/track/exchange", {
      token: second.trackToken,
    });
    expect(live.status).toBe(200);
  });

  it("a check-in without a live proof is refused", async () => {
    const res = await post("/api/walk-in/kiosk/check-in", {
      token: kioskToken,
      proof: randomToken(32),
      phone: freshPhone(),
      firstName: "Nope",
      serviceIds: [serviceId],
      preferredStaffId: null,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("verification_required");
  });

  it("client-supplied authority is ignored or refused: unknown service, foreign service, inactive staff, junk fields", async () => {
    const phone = freshPhone();
    await post("/api/walk-in/kiosk/challenge", { token: kioskToken, phone });
    const v = await post("/api/walk-in/kiosk/verify", {
      token: kioskToken,
      phone,
      code: codeFor(phone),
    });
    const base = {
      token: kioskToken,
      proof: v.body.proof,
      phone,
      firstName: "Cust",
      preferredStaffId: null,
    };
    // .strict() zod: invented authority fields are a 404-shaped rejection.
    const junk = await post("/api/walk-in/kiosk/check-in", {
      ...base,
      serviceIds: [serviceId],
      price: 1,
      position: 0,
      waitMin: 0,
    });
    expect(junk.status).toBe(404);
    // A service id from another shop is indistinguishable from an unknown one.
    const foreignSvc = await post("/api/walk-in/kiosk/check-in", {
      ...base,
      serviceIds: ["cl_does_not_exist"],
    });
    expect(foreignSvc.status).toBe(400);
    expect(foreignSvc.body.error).toBe("service_not_found");
  });

  it("no SMS body or ledger row ever carries a stored code, token, or phone-derived key", async () => {
    const phone = freshPhone();
    await fullCheckIn(phone);
    // Nudge rows for walk_in kinds carry NO body (the link IS a credential).
    const nudges = await prisma.nudge.findMany({
      where: { shopId, kind: { startsWith: "walk_in" } },
    });
    for (const n of nudges) expect(n.body).toBeNull();
    // Audit rows: no phone, no token, no name.
    const events = await prisma.walkInEvent.findMany({ where: { shopId } });
    const flat = JSON.stringify(events);
    expect(flat).not.toMatch(/\+1212555/);
    expect(flat).not.toContain("Cust");
    // Rate-limit storage never keys on a phone (the table is shared across
    // suites, so the assertion is scoped to THIS suite's phone prefix).
    const keys = await prisma.$queryRaw<{ key: string }[]>`
      SELECT "key" FROM "rate_limit_counter"`;
    for (const k of keys) expect(k.key).not.toMatch(/1212555/);
  });
});

describe("tracking over HTTP", () => {
  it("exchange -> status shows only the caller's own spot; leave settles it", async () => {
    const phone = freshPhone();
    const mine = await fullCheckIn(phone);
    await fullCheckIn(freshPhone()); // someone else
    const ex = await post("/api/walk-in/track/exchange", { token: mine.trackToken });
    expect(ex.status).toBe(200);
    const st = await post("/api/walk-in/track/status", { session: ex.body.session });
    expect(st.status).toBe(200);
    expect(st.body.shopName).toBe("Kiosk Cuts");
    expect(typeof st.body.ahead).toBe("number");
    const flat = JSON.stringify(st.body);
    expect(flat).not.toMatch(/\+1212555/);
    expect(flat).not.toMatch(/"id"/);

    const leave = await post("/api/walk-in/track/leave", { session: ex.body.session });
    expect(leave.status).toBe(200);
    expect(leave.body.status).toBe("LEFT");
    const again = await post("/api/walk-in/track/leave", { session: ex.body.session });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("LEFT");
  });

  it("unknown, garbage and expired credentials collapse into the same 404", async () => {
    const garbage = await post("/api/walk-in/track/exchange", { token: "x" });
    const unknown = await post("/api/walk-in/track/exchange", {
      token: randomToken(32),
    });
    const badSession = await post("/api/walk-in/track/status", {
      session: randomToken(32),
    });
    for (const r of [garbage, unknown, badSession]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "not_found" });
    }
  });
});
