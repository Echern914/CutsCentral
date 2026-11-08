import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests, smsEnabled } from "../messaging/twilio.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { logger } from "../logger.js";
import {
  recoveryEmail,
  recoveryPairDigest,
  RECOVERY_PURPOSE,
} from "../services/rewardsRecovery.js";
import {
  billableSegments,
  hourStamp,
  readRecoverySmsCosts,
} from "../services/recoverySmsBudget.js";

/**
 * Rewards recovery from the OUTSIDE: constancy, the email it sends, and the
 * legacy mobile route - which shares ONE challenge engine with the new one, so
 * switching doors buys no extra allowance.
 *
 * Sends are FIRE-AND-FORGET (the response leaves before any provider work on
 * every path), so email assertions go through `settle()` - a bounded poll, not
 * a sleep-and-hope.
 */

const app = createApp();
const emails: string[] = [];
let shopA: string;
let shopB: string;
let ownerCookieA: string;
let mail: SendEmailInput[] = [];
let texts: SendMessageInput[] = [];
let phoneSeq = 0;

/** Distinct prefix so PII sweeps of shared stores stay scoped to this suite. */
function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(8000 + phoneSeq).padStart(4, "0")}`;
}

const emailOf = (phone: string) => `cust${phone.slice(1)}@test.local`;

/** Bounded wait for the fire-and-forget pipeline - never a bare sleep. */
async function settle(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("settle: condition never became true");
}

const mailTo = (to: string) => mail.filter((m) => m.to === to);

function codeFor(to: string): string {
  const subject = [...mail].reverse().find((m) => m.to === to)?.subject ?? "";
  const m = /(\d{6})/.exec(subject);
  expect(m, "no code email").toBeTruthy();
  return m![1]!;
}

const post = (path: string, body: unknown) => request(app).post(path).send(body as object);

async function makeShopOwner(label: string, shopName: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true, acceptTerms: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, smsAttested: true });
  return { cookie, shopId: shop.body.id as string };
}

/** A client with an address on file, textable for the manager resend's sake. */
async function makeClient(shopId: string, phone: string, over: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `${phone}-${randomToken(4)}`,
      firstName: "Cust",
      phone,
      email: emailOf(phone),
      magicToken: randomToken(),
      smsConsentAt: new Date(),
      optedOut: false,
      ...over,
    },
    select: { id: true, magicToken: true },
  });
}

const recordEmail = async (input: SendEmailInput) => {
  mail.push(input);
  return { id: `TEST${mail.length}`, status: "sent" as const };
};

beforeAll(async () => {
  process.env.DRY_RUN = "true";
  __setSendEmailForTests(recordEmail);
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      texts.push(input);
      return { sid: `TEST${texts.length}`, status: "sent" };
    },
  });
  const a = await makeShopOwner("rrec-a", "Alpha Fades");
  shopA = a.shopId;
  ownerCookieA = a.cookie;
  shopB = (await makeShopOwner("rrec-b", "Bravo Fades")).shopId;
});

afterEach(async () => {
  mail = [];
  texts = [];
  __setSendEmailForTests(recordEmail);
  await prisma.phoneRecoveryCode.deleteMany({});
  await prisma.nudge.deleteMany({ where: { shopId: { in: [shopA, shopB] } } });
  await prisma.client.deleteMany({ where: { shopId: { in: [shopA, shopB] } } });
  // The platform budget windows would otherwise accumulate across tests.
  await prisma.rateLimitCounter.deleteMany({
    where: { OR: [{ key: { startsWith: "recSms:" } }, { key: { startsWith: "recEmail:" } }] },
  });
  delete process.env.RECOVERY_SMS_HOURLY_CAP;
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("constancy and the zero-send floor", () => {
  it("🔴 an UNKNOWN but valid E.164 sends NOTHING - and the same ok", async () => {
    const known = freshPhone();
    const unknown = freshPhone();
    await makeClient(shopA, known);

    const rKnown = await post("/api/rewards-recovery/challenge", { phone: known });
    const rUnknown = await post("/api/rewards-recovery/challenge", { phone: unknown });
    expect(rKnown.body).toEqual({ ok: true });
    expect(rUnknown.body).toEqual(rKnown.body);

    await settle(() => mailTo(emailOf(known)).length > 0);
    expect(mail).toHaveLength(1);
    // No row, no spendable anything.
    expect(await prisma.phoneRecoveryCode.count({})).toBe(1);
  });

  it("🔴 a number with no email on file is byte-identical too, and sends nothing", async () => {
    const noEmail = freshPhone();
    await makeClient(shopA, noEmail, { email: null });
    const r = await post("/api/rewards-recovery/challenge", { phone: noEmail });
    expect(r.body).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 50)); // give a wrong send time to appear
    expect(mail).toHaveLength(0);
    expect(await prisma.phoneRecoveryCode.count({})).toBe(0);
  });

  it("🔴 a MULTI-SHOP number with one address gets exactly ONE email, naming no shop", async () => {
    const multi = freshPhone();
    await makeClient(shopA, multi);
    await makeClient(shopB, multi);
    await post("/api/rewards-recovery/challenge", { phone: multi });
    await settle(() => mailTo(emailOf(multi)).length > 0);
    const mine = mailTo(emailOf(multi));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text + mine[0]!.subject + mine[0]!.html).not.toMatch(/Alpha|Bravo/);
  });

  it("verify failures are one body for wrong, replayed and never-issued", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    const code = codeFor(emailOf(phone));
    const wrongCode = code === "000000" ? "000001" : "000000";

    const wrong = await post("/api/rewards-recovery/verify", { phone, code: wrongCode });
    const neverIssued = await post("/api/rewards-recovery/verify", {
      phone: freshPhone(),
      code,
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toEqual({ verified: false });
    expect(neverIssued.body).toEqual(wrong.body);

    const okRes = await post("/api/rewards-recovery/verify", { phone, code });
    expect(okRes.body.verified).toBe(true);
    const replay = await post("/api/rewards-recovery/verify", { phone, code });
    expect(replay.body).toEqual(wrong.body);
  });

  it("a bad proof at the chooser and at select is one generic 404", async () => {
    const bogus = randomToken(32);
    const shops = await post("/api/rewards-recovery/shops", { proof: bogus });
    const select = await post("/api/rewards-recovery/select", {
      proof: bogus,
      selectionId: "a".repeat(32),
    });
    expect(shops.status).toBe(404);
    expect(select.status).toBe(404);
    expect(shops.body).toEqual(select.body);
  });
});

describe("🔴 it works with texting OFF, which is the whole reason it is email", () => {
  it("🔴 SMS_ENABLED=false: a customer gets the code and reaches their rewards, and no text is sent", async () => {
    const before = process.env.SMS_ENABLED;
    process.env.SMS_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      expect(smsEnabled()).toBe(false);
      const phone = freshPhone();
      const client = await makeClient(shopA, phone);
      await post("/api/rewards-recovery/challenge", { phone });
      await settle(() => mailTo(emailOf(phone)).length > 0);

      const v = await post("/api/rewards-recovery/verify", { phone, code: codeFor(emailOf(phone)) });
      expect(v.body.verified).toBe(true);
      const chooser = await post("/api/rewards-recovery/shops", { proof: v.body.proof });
      expect(chooser.body.shops.map((s: { name: string }) => s.name)).toEqual(["Alpha Fades"]);
      const sel = await post("/api/rewards-recovery/select", {
        proof: v.body.proof,
        selectionId: chooser.body.shops[0].selectionId,
      });
      expect(sel.body.url).toContain(`/r/${client.magicToken}/rewards`);
      expect(texts).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.SMS_ENABLED;
      else process.env.SMS_ENABLED = before;
      __resetEnvCacheForTests();
    }
  });

  it("🔴 a client who replied STOP to texts still gets back to their rewards by email", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone, { optedOut: true, optOutSource: "sms_stop", smsConsentAt: null });
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    expect(texts).toHaveLength(0);
  });
});

describe("the email", () => {
  it("🔴 has the code and the door, and nothing person-shaped", () => {
    const { subject, text, html } = recoveryEmail("123456");
    expect(subject).toContain("123456");
    for (const body of [text, html]) {
      expect(body).toContain("/my-rewards");
      expect(body).toContain("123456");
      expect(body).toContain("expires in 5 minutes");
      // Nothing that identifies anyone or anything: no shop, no name, no token,
      // no phone, and no credential riding the URL.
      expect(body).not.toMatch(/Alpha|Bravo|Cust/);
      expect(body).not.toMatch(/\/r\//);
      expect(body).not.toMatch(/\+1\d{10}/);
    }
    expect(text).not.toMatch(/my-rewards[/?#]\S/); // the URL carries NOTHING
    expect(html).not.toMatch(/my-rewards[/?#]/);
  });

  it("is sent to the address on file, tagged so a bounce can be read later, carrying no id", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    expect(mailTo(emailOf(phone))[0]!.meta).toEqual({ kind: "rewards_recovery" });
  });
});

describe("one complete recovery costs exactly one email", () => {
  it("🔴 the NEW flow: challenge -> verify -> chooser -> select, one send total", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone);
    const b = await makeClient(shopB, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    const v = await post("/api/rewards-recovery/verify", { phone, code: codeFor(emailOf(phone)) });
    const proof = v.body.proof as string;
    const chooser = await post("/api/rewards-recovery/shops", { proof });
    expect(chooser.body.shops).toHaveLength(2);
    const flat = JSON.stringify(chooser.body);
    expect(flat).not.toContain(a.magicToken);
    expect(flat).not.toContain(shopA);
    expect(flat).not.toContain(phone);
    expect(flat).not.toContain(emailOf(phone));
    const bravo = chooser.body.shops.find((s: { name: string }) => s.name === "Bravo Fades");
    const sel = await post("/api/rewards-recovery/select", {
      proof,
      selectionId: bravo.selectionId,
    });
    expect(sel.body.url).toContain(`/r/${b.magicToken}/rewards`);
    expect(mailTo(emailOf(phone))).toHaveLength(1);
  });

  it("🔴 the LEGACY journey: one POST, ONE message carrying code + door, verified through the chooser", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    const res = await post("/api/rewards/resolve-by-phone", { phone });
    expect(res.body).toEqual({ ok: true });
    await settle(() => mailTo(emailOf(phone)).length > 0);

    const mine = mailTo(emailOf(phone));
    expect(mine).toHaveLength(1);
    // The ONE message: the code AND the door, no shop, no rewards link.
    expect(mine[0]!.text).toContain("/my-rewards");
    expect(mine[0]!.text).toMatch(/\d{6}/);
    expect(mine[0]!.text).not.toMatch(/Alpha/);
    expect(mine[0]!.text).not.toContain("/r/");

    // The customer enters the phone and THAT code - no second send anywhere.
    const v = await post("/api/rewards-recovery/verify", { phone, code: codeFor(emailOf(phone)) });
    expect(v.body.verified).toBe(true);
    const chooser = await post("/api/rewards-recovery/shops", { proof: v.body.proof });
    expect(chooser.status).toBe(200);
    expect(chooser.body.shops.map((s: { name: string }) => s.name)).toEqual(["Alpha Fades"]);
    expect(mailTo(emailOf(phone))).toHaveLength(1);
  });

  it("🔴 legacy known/unknown answer byte-identically", async () => {
    const known = freshPhone();
    await makeClient(shopA, known);
    const r1 = await post("/api/rewards/resolve-by-phone", { phone: known });
    const r2 = await post("/api/rewards/resolve-by-phone", { phone: freshPhone() });
    expect(r1.status).toBe(r2.status);
    expect(r1.body).toEqual(r2.body);
  });
});

describe("one shared allowance across every self-serve door", () => {
  it("🔴 alternating legacy and new draws ONE cooldown budget - not two", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards/resolve-by-phone", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    // Same number, other door, inside the cooldown: nothing.
    await post("/api/rewards-recovery/challenge", { phone });
    await post("/api/rewards/resolve-by-phone", { phone });
    await post("/api/rewards-recovery/challenge", { phone });
    await new Promise((r) => setTimeout(r, 100));
    expect(mailTo(emailOf(phone))).toHaveLength(1);
  });
});

describe("the manager's text is its own door now", () => {
  it("🔴 a recovery email leaves no text trail, so it never blocks the manager's resend", async () => {
    const phone = freshPhone();
    const client = await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    expect(await prisma.nudge.count({ where: { clientId: client.id } })).toBe(0);

    const resend = await request(app)
      .post(`/api/dashboard/clients/${client.id}/rewards-link`)
      .set("Cookie", ownerCookieA);
    expect(resend.status).toBe(200);
    expect(texts.filter((t) => t.to === phone)).toHaveLength(1);
  });

  it("🔴 a recovery email spends none of the SMS budget, and its own ledger counts it", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    expect(
      await prisma.rateLimitCounter.count({ where: { key: { startsWith: "recSms:" } } }),
    ).toBe(0);
    const hour = await prisma.rateLimitCounter.findFirst({
      where: { key: { startsWith: "recEmail:budget:h:" } },
    });
    expect(hour!.hits).toBe(1);
  });

  it("🔴 the manager door has a DAILY ceiling on top of the 5-minute cooldown", async () => {
    const phone = freshPhone();
    const client = await makeClient(shopA, phone);
    // Backfill 5 loyalty nudges spread over the day - all past the 5-min
    // cooldown, all inside 24h.
    for (let i = 1; i <= 5; i++) {
      await prisma.nudge.create({
        data: {
          shopId: shopA,
          clientId: client.id,
          channel: "SMS",
          status: "SENT",
          kind: "loyalty",
          body: "x",
          createdAt: new Date(Date.now() - i * 60 * 60 * 1000),
        },
      });
    }
    const res = await request(app)
      .post(`/api/dashboard/clients/${client.id}/rewards-link`)
      .set("Cookie", ownerCookieA);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_today");
    expect(texts.filter((t) => t.to === phone)).toHaveLength(0);
  });
});

describe("provider failure discipline", () => {
  const HOSTILE = {
    otp: "SECRET_OTP_999111",
    auth: "Authorization: Bearer re_hostile_cred",
    id: "resend_msg_deadbeef",
  };

  it("🔴 a hostile provider error reaches NO log line", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const infoSpy = vi.spyOn(logger, "info");
    __setSendEmailForTests(async (input) => {
      throw new Error(
        `provider exploded for ${input.to} ${phone} otp=${HOSTILE.otp} body="${input.text}" ${HOSTILE.auth} ${HOSTILE.id}`,
      );
    });
    try {
      await post("/api/rewards-recovery/challenge", { phone });
      await settle(() =>
        warnSpy.mock.calls.some((c) => c[0] === "rewards recovery: challenge send failed"),
      );

      const everything = JSON.stringify([
        warnSpy.mock.calls,
        errorSpy.mock.calls,
        infoSpy.mock.calls,
      ]);
      for (const fragment of Object.values(HOSTILE)) {
        expect(everything).not.toContain(fragment);
      }
      // And no raw destination either.
      expect(everything).not.toContain(phone);
      expect(everything).not.toContain(emailOf(phone));
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("🔴 a provider timeout consumes the allowance and NEVER retries", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    let calls = 0;
    __setSendEmailForTests(async () => {
      calls += 1;
      throw new Error("ETIMEDOUT");
    });
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => calls > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1); // exactly one dispatch, no retry
    // The allowance was spent: the row's send counter advanced anyway.
    const row = await prisma.phoneRecoveryCode.findFirst({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)), purpose: RECOVERY_PURPOSE },
    });
    expect(row!.sendCount).toBe(1);
  });

  it("🔴 a dispatch that never returns still answers, with the allowance consumed", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    // The process "dies mid-dispatch": the promise simply never settles.
    __setSendEmailForTests(() => new Promise(() => {}));
    const res = await post("/api/rewards-recovery/challenge", { phone });
    expect(res.body).toEqual({ ok: true });
    const row = await prisma.phoneRecoveryCode.findFirst({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)), purpose: RECOVERY_PURPOSE },
    });
    expect(row!.sendCount).toBe(1); // allowance consumed, never refunded
    const budget = await prisma.rateLimitCounter.findFirst({
      where: { key: { startsWith: "recEmail:budget:h:" } },
    });
    expect(budget!.hits).toBeGreaterThanOrEqual(1);
  });
});

describe("the manager's text is still budgeted in segments", () => {
  it("🔴 its production body is exactly ONE billable GSM-7 segment", () => {
    const managerBody = `Your ChairBack rewards link: https://getchairback.com/r/${"x".repeat(43)}/rewards Reply STOP to opt out.`;
    expect(billableSegments(managerBody)).toBe(1);
  });

  it("a two-segment message counts as two units, and UCS-2 shrinks the segment", () => {
    expect(billableSegments("a".repeat(160))).toBe(1);
    expect(billableSegments("a".repeat(161))).toBe(2); // concatenated GSM-7
    expect(billableSegments("😀" + "a".repeat(69))).toBe(2); // UCS-2, 71 units
    expect(billableSegments("{}".repeat(41))).toBe(2); // extension chars cost 2 septets
  });

  it("🔴 a reservation cannot PARTIALLY fit past the cap", async () => {
    // Cap 3; take 2, then ask for 2 more: refused whole, counter stays at 2.
    const { takeRecoverySmsBudget } = await import("../services/recoverySmsBudget.js");
    const { runAsOwner } = await import("@chairback/db");
    process.env.RECOVERY_SMS_HOURLY_CAP = "3";
    const now = new Date();
    expect(await runAsOwner((tx) => takeRecoverySmsBudget(tx, now, 2))).toBe(true);
    expect(await runAsOwner((tx) => takeRecoverySmsBudget(tx, now, 2))).toBe(false);
    const row = await prisma.rateLimitCounter.findUnique({
      where: { key: `recSms:budget:h:${hourStamp(now)}` },
    });
    expect(row!.hits).toBe(2); // not 3, not 4 - nothing partial
  });
});

describe("no credential ever reaches an audit row", () => {
  it("🔴 a manager Nudge carries no magic token, phone or outbound body", async () => {
    const phone = freshPhone();
    const client = await makeClient(shopA, phone);
    await request(app)
      .post(`/api/dashboard/clients/${client.id}/rewards-link`)
      .set("Cookie", ownerCookieA);

    const nudges = await prisma.nudge.findMany({ where: { clientId: client.id } });
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    const flat = JSON.stringify(nudges.map((n) => [n.body, n.failedReason]));
    expect(flat).not.toContain(client.magicToken);
    expect(flat).not.toMatch(/\+1212555/);
    for (const sms of texts) {
      expect(flat).not.toContain(sms.body); // no stored outbound body, period
    }
  });
});

describe("admin cost summary", () => {
  it("counts the manager door's sends", async () => {
    const phone = freshPhone();
    const client = await makeClient(shopA, phone);
    await request(app)
      .post(`/api/dashboard/clients/${client.id}/rewards-link`)
      .set("Cookie", ownerCookieA);
    // Metrics are fire-and-forget: settle on the counter itself.
    await settle(async () => {
      const c = await readRecoverySmsCosts(new Date());
      return c.currentHour.attempt! >= 1 && c.currentHour.segments! >= 1;
    });
    const costs = await readRecoverySmsCosts(new Date());
    expect(costs.currentHour.attempt).toBeGreaterThanOrEqual(1);
    expect(costs.caps.hourly).toBeGreaterThan(0);
  });
});

describe("nothing leaks into shared stores", () => {
  it("🔴 no raw phone or address in the recovery store or budget keys", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => mailTo(emailOf(phone)).length > 0);
    const rows = await prisma.phoneRecoveryCode.findMany({});
    expect(JSON.stringify(rows)).not.toMatch(/\+1212555/);
    expect(JSON.stringify(rows)).not.toContain(emailOf(phone));
    // Budget keys are pure timestamps - never a phone, address, hash or IP.
    const counters = await prisma.rateLimitCounter.findMany({
      where: { key: { startsWith: "recEmail:" } },
      select: { key: true },
    });
    expect(counters.length).toBeGreaterThan(0);
    for (const c of counters) {
      expect(c.key).toMatch(/^recEmail:budget:[hd]:\d+$/);
    }
  });
});
