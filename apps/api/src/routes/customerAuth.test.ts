import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { logger } from "../logger.js";
import { billableSegments } from "../services/recoverySmsBudget.js";
import { identifierDigest, signInSmsBody } from "../services/customerSignIn.js";
import { customerSessionFromToken } from "../auth/customerSession.js";

/**
 * My ChairBack sign-in from the OUTSIDE.
 *
 * What must hold: sending never reveals whether a contact is known; a code
 * works once, for its own channel, and only within its limits; the first good
 * code creates the account and every later one finds it; a brand-new customer
 * gets in (unlike recovery, which rightly refuses unknown numbers); and no
 * phone, email or code ever reaches a log line.
 *
 * Sends are fire-and-forget, so delivery assertions go through `settle()`.
 */

const app = createApp();
let sms: SendMessageInput[] = [];
let mail: { to: string; subject: string; text: string }[] = [];
let seq = 0;
const accountIds = new Set<string>();
/** Every contact this suite used, so cleanup is scoped to OUR rows only. */
const usedHashes = new Set<string>();

function freshPhone(): string {
  seq += 1;
  const phone = `+1415555${String(3000 + seq).padStart(4, "0")}`;
  usedHashes.add(identifierDigest("sms", phone));
  return phone;
}
function freshEmail(): string {
  seq += 1;
  const email = `signin-${seq}-${randomToken(4).toLowerCase()}@test.local`;
  usedHashes.add(identifierDigest("email", email));
  return email;
}

async function settle(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("settle: condition never became true");
}

function lastSmsCode(phone: string): string {
  const body = [...sms].reverse().find((s) => s.to === phone)?.body ?? "";
  return /(\d{6})/.exec(body)![1]!;
}
function lastEmailCode(email: string): string {
  const m = [...mail].reverse().find((s) => s.to === email);
  return /(\d{6})/.exec(m?.subject ?? "")![1]!;
}

/**
 * A client IP of this RUN's own (the app trusts one proxy hop). The per-IP
 * ceiling counts rows on the table, so without this, rows from a parallel
 * suite or an earlier run on the shared loopback address would decide this
 * run's results.
 */
const octet = () => 1 + Math.floor(Math.random() * 250);
const RUN_IP = `10.${octet()}.${octet()}.${octet()}`;

const post = (path: string, body: unknown, ip = RUN_IP) =>
  request(app).post(path).set("X-Forwarded-For", ip).send(body as object);

async function signIn(phone: string): Promise<request.Response> {
  // Wait for THIS request's text, not any earlier one: re-issuing supersedes
  // the previous code, so reading the older message would type a dead code.
  const before = sms.filter((s) => s.to === phone).length;
  await post("/api/customer-auth/start", { channel: "sms", phone });
  await settle(() => sms.filter((s) => s.to === phone).length > before);
  const res = await post("/api/customer-auth/verify", { channel: "sms", phone, code: lastSmsCode(phone) });
  const aid = res.body.token ? customerSessionFromToken(res.body.token)?.accountId : undefined;
  if (aid) accountIds.add(aid);
  return res;
}

beforeAll(() => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.DRY_RUN = "true";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sms.push(input);
      return { sid: `TEST${sms.length}`, status: "sent" };
    },
  });
  __setSendEmailForTests(async (input) => {
    mail.push({ to: input.to, subject: input.subject, text: input.text });
    return { id: `EMAIL${mail.length}`, status: "sent" };
  });
});

afterEach(async () => {
  sms = [];
  mail = [];
  // Every test shares one client IP, so the per-IP ceiling would otherwise
  // carry over between tests. Only this suite's rows are removed.
  await prisma.customerSignInCode.deleteMany({ where: { identifierHash: { in: [...usedHashes] } } });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "custSms:" } } });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "custEmail:" } } });
  delete process.env.CUSTOMER_SIGNIN_SMS_HOURLY_CAP;
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.size > 0) {
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  }
  await prisma.$disconnect();
});

describe("the switch", () => {
  it("flag off -> every sign-in route is a plain 404", async () => {
    process.env.CUSTOMER_ACCOUNTS_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      for (const path of ["/api/customer-auth/start", "/api/customer-auth/verify", "/api/customer-auth/demo"]) {
        const res = await post(path, { channel: "sms", phone: freshPhone(), code: "123456" });
        expect(res.status, path).toBe(404);
      }
      expect(sms).toHaveLength(0);
    } finally {
      process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });
});

describe("sending a code", () => {
  it("a brand-new number gets a code - sign-in is how new customers get in", async () => {
    const phone = freshPhone();
    const res = await post("/api/customer-auth/start", { channel: "sms", phone });
    expect(res.body).toEqual({ ok: true });
    await settle(() => sms.some((s) => s.to === phone));
    expect(lastSmsCode(phone)).toMatch(/^\d{6}$/);
  });

  it("the text is ONE GSM-7 segment and names no shop, person or link", () => {
    const body = signInSmsBody("123456");
    expect(billableSegments(body)).toBe(1);
    expect(body).not.toMatch(/https?:|\/r\//);
  });

  it("an email address gets its code by email", async () => {
    const email = freshEmail();
    const res = await post("/api/customer-auth/start", { channel: "email", email: `  ${email.toUpperCase()} ` });
    expect(res.body).toEqual({ ok: true });
    await settle(() => mail.some((m) => m.to === email));
    expect(lastEmailCode(email)).toMatch(/^\d{6}$/);
  });

  it("a number outside North America is refused by FORMAT - and nothing is sent", async () => {
    const res = await post("/api/customer-auth/start", { channel: "sms", phone: "+44 20 7946 0958" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("phone_not_supported");
    const junk = await post("/api/customer-auth/start", { channel: "sms", phone: "12" });
    expect(junk.body.error).toBe("invalid_phone");
    const bad = await post("/api/customer-auth/start", { channel: "email", email: "not-an-email" });
    expect(bad.body.error).toBe("invalid_email");
    await new Promise((r) => setTimeout(r, 50));
    expect(sms).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("one IP minting codes for many numbers stops at the ceiling - same ok, no send", async () => {
    const ip = `10.${octet()}.${octet()}.${octet()}`;
    const phones = Array.from({ length: 12 }, () => freshPhone());
    for (const phone of phones) {
      const res = await post("/api/customer-auth/start", { channel: "sms", phone }, ip);
      expect(res.body).toEqual({ ok: true });
    }
    await settle(() => sms.length >= 10);
    await new Promise((r) => setTimeout(r, 50));
    expect(sms).toHaveLength(10);
  });

  it("a second request inside the cooldown answers the same ok and sends nothing", async () => {
    const phone = freshPhone();
    await post("/api/customer-auth/start", { channel: "sms", phone });
    await settle(() => sms.length === 1);
    const again = await post("/api/customer-auth/start", { channel: "sms", phone });
    expect(again.body).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(sms).toHaveLength(1);
  });

  it("🔴 the platform text budget fails CLOSED - same ok, no send", async () => {
    process.env.CUSTOMER_SIGNIN_SMS_HOURLY_CAP = "1";
    const a = freshPhone();
    const b = freshPhone();
    await post("/api/customer-auth/start", { channel: "sms", phone: a });
    await settle(() => sms.length === 1);
    const refused = await post("/api/customer-auth/start", { channel: "sms", phone: b });
    expect(refused.body).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(sms.map((s) => s.to)).toEqual([a]);
  });

  it("stores only an HMAC of the contact - never the number itself", async () => {
    const phone = freshPhone();
    await post("/api/customer-auth/start", { channel: "sms", phone });
    await settle(() => sms.some((s) => s.to === phone));
    const row = await prisma.customerSignInCode.findUnique({
      where: { channel_identifierHash: { channel: "sms", identifierHash: identifierDigest("sms", phone) } },
    });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(phone.slice(2));
    expect(row!.codeHash).not.toContain(lastSmsCode(phone));
  });
});

describe("checking a code", () => {
  it("the first good code creates the account; the next sign-in finds the SAME one", async () => {
    const phone = freshPhone();
    const first = await signIn(phone);
    expect(first.body.verified).toBe(true);
    expect(first.body.account.isNew).toBe(true);
    const aid = customerSessionFromToken(first.body.token)!.accountId;

    await new Promise((r) => setTimeout(r, 5));
    // Beat the cooldown for the second send.
    await prisma.customerSignInCode.updateMany({
      where: { identifierHash: identifierDigest("sms", phone) },
      data: { lastSentAt: new Date(Date.now() - 2 * 60 * 1000) },
    });
    const second = await signIn(phone);
    expect(second.body.account.isNew).toBe(false);
    expect(customerSessionFromToken(second.body.token)!.accountId).toBe(aid);

    const account = await prisma.customerAccount.findUnique({ where: { id: aid } });
    expect(account!.phoneE164).toBe(phone);
    expect(account!.phoneVerifiedAt).not.toBeNull();
  });

  it("a code works exactly once", async () => {
    const phone = freshPhone();
    await post("/api/customer-auth/start", { channel: "sms", phone });
    await settle(() => sms.some((s) => s.to === phone));
    const code = lastSmsCode(phone);
    const ok = await post("/api/customer-auth/verify", { channel: "sms", phone, code });
    accountIds.add(customerSessionFromToken(ok.body.token)!.accountId);
    const replay = await post("/api/customer-auth/verify", { channel: "sms", phone, code });
    expect(replay.body).toEqual({ verified: false });
  });

  it("wrong, never-issued and malformed all refuse the same way", async () => {
    const phone = freshPhone();
    await post("/api/customer-auth/start", { channel: "sms", phone });
    await settle(() => sms.some((s) => s.to === phone));
    const good = lastSmsCode(phone);
    const wrong = good === "000000" ? "111111" : "000000";
    expect((await post("/api/customer-auth/verify", { channel: "sms", phone, code: wrong })).body).toEqual({
      verified: false,
    });
    expect(
      (await post("/api/customer-auth/verify", { channel: "sms", phone: freshPhone(), code: good })).body,
    ).toEqual({ verified: false });
    expect((await post("/api/customer-auth/verify", { channel: "sms", phone, code: "12ab" })).body).toEqual({
      verified: false,
    });
  });

  it("five wrong guesses lock the code - the right one then fails too", async () => {
    const phone = freshPhone();
    await post("/api/customer-auth/start", { channel: "sms", phone });
    await settle(() => sms.some((s) => s.to === phone));
    const good = lastSmsCode(phone);
    const wrong = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await post("/api/customer-auth/verify", { channel: "sms", phone, code: wrong });
    }
    expect((await post("/api/customer-auth/verify", { channel: "sms", phone, code: good })).body).toEqual({
      verified: false,
    });
  });

  it("an email sign-in makes an email account", async () => {
    const email = freshEmail();
    await post("/api/customer-auth/start", { channel: "email", email });
    await settle(() => mail.some((m) => m.to === email));
    const res = await post("/api/customer-auth/verify", { channel: "email", email, code: lastEmailCode(email) });
    expect(res.body.verified).toBe(true);
    const aid = customerSessionFromToken(res.body.token)!.accountId;
    accountIds.add(aid);
    const account = await prisma.customerAccount.findUnique({ where: { id: aid } });
    expect(account!.emailNormalized).toBe(email);
    expect(account!.phoneE164).toBeNull();
  });
});

describe("nothing person-shaped in a log line", () => {
  it("🔴 a hostile provider's error never reaches a log - not the number, the code or a credential", async () => {
    const phone = freshPhone();
    const HOSTILE = "Authorization: Bearer SK_customer_hostile";
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const info = vi.spyOn(logger, "info");
    let thrown = "";
    __setMessageProviderForTests({
      channel: "SMS",
      send: async (input) => {
        thrown = input.body;
        throw new Error(`exploded for ${input.to} body=${input.body} ${HOSTILE}`);
      },
    });
    try {
      await post("/api/customer-auth/start", { channel: "sms", phone });
      await settle(() => warn.mock.calls.some((c) => String(c[1]).includes("customer sign-in")));
      const everything = JSON.stringify([warn.mock.calls, error.mock.calls, info.mock.calls]);
      expect(everything).not.toContain(phone);
      expect(everything).not.toContain(phone.slice(2));
      expect(everything).not.toContain(HOSTILE);
      expect(everything).not.toContain(/(\d{6})/.exec(thrown)![1]!);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
      __setMessageProviderForTests({
        channel: "SMS",
        send: async (input) => {
          sms.push(input);
          return { sid: `TEST${sms.length}`, status: "sent" };
        },
      });
    }
  });
});
