import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { logger } from "../logger.js";
import { phoneDigest, recoverySmsBody, RECOVERY_PURPOSE } from "../services/rewardsRecovery.js";

/**
 * Rewards recovery from the OUTSIDE: constancy, the SMS cost boundary, and
 * the legacy mobile route - which now shares ONE challenge engine with the
 * new one, so switching doors buys no extra allowance.
 *
 * Sends are FIRE-AND-FORGET (the response leaves before any provider work on
 * every path), so SMS assertions go through `settle()` - a bounded poll, not a
 * sleep-and-hope.
 */

const app = createApp();
const emails: string[] = [];
let shopA: string;
let shopB: string;
let ownerCookieA: string;
let sent: SendMessageInput[] = [];
let phoneSeq = 0;

/** Distinct prefix so PII sweeps of shared stores stay scoped to this suite. */
function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(8000 + phoneSeq).padStart(4, "0")}`;
}

/** Bounded wait for the fire-and-forget pipeline - never a bare sleep. */
async function settle(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("settle: condition never became true");
}

function codeFor(phone: string): string {
  const body = [...sent].reverse().find((s) => s.to === phone)?.body ?? "";
  const m = /(\d{6})/.exec(body);
  expect(m, "no code SMS").toBeTruthy();
  return m![1]!;
}

const post = (path: string, body: unknown) => request(app).post(path).send(body as object);

async function makeShopOwner(label: string, shopName: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, smsAttested: true });
  return { cookie, shopId: shop.body.id as string };
}

/** A TEXTABLE client - the only kind a recovery SMS may be sent for. */
async function makeClient(shopId: string, phone: string, over: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `${phone}-${randomToken(4)}`,
      firstName: "Cust",
      phone,
      magicToken: randomToken(),
      smsConsentAt: new Date(),
      optedOut: false,
      ...over,
    },
    select: { id: true, magicToken: true },
  });
}

beforeAll(async () => {
  process.env.DRY_RUN = "true";
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `TEST${sent.length}`, status: "sent" };
    },
  });
  const a = await makeShopOwner("rrec-a", "Alpha Fades");
  shopA = a.shopId;
  ownerCookieA = a.cookie;
  shopB = (await makeShopOwner("rrec-b", "Bravo Fades")).shopId;
});

afterEach(async () => {
  sent = [];
  await prisma.phoneRecoveryCode.deleteMany({});
  await prisma.nudge.deleteMany({ where: { shopId: { in: [shopA, shopB] } } });
  await prisma.client.deleteMany({ where: { shopId: { in: [shopA, shopB] } } });
  // The platform budget windows would otherwise accumulate across tests.
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "recSms:" } } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("constancy and the zero-cost floor", () => {
  it("🔴 an UNKNOWN but valid E.164 causes ZERO provider calls - and the same ok", async () => {
    const known = freshPhone();
    const unknown = freshPhone();
    await makeClient(shopA, known);

    const rKnown = await post("/api/rewards-recovery/challenge", { phone: known });
    const rUnknown = await post("/api/rewards-recovery/challenge", { phone: unknown });
    expect(rKnown.body).toEqual({ ok: true });
    expect(rUnknown.body).toEqual(rKnown.body);

    await settle(() => sent.some((s) => s.to === known));
    expect(sent.filter((s) => s.to === unknown)).toHaveLength(0);
    // No row, no spendable anything.
    expect(
      await prisma.phoneRecoveryCode.count({ where: { phoneHash: phoneDigest(unknown) } }),
    ).toBe(0);
  });

  it("🔴 an all-opted-out phone is byte-identical too, and costs nothing", async () => {
    const stopped = freshPhone();
    await makeClient(shopA, stopped, { optedOut: true, optOutSource: "sms_stop" });
    const r = await post("/api/rewards-recovery/challenge", { phone: stopped });
    expect(r.body).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 50)); // give a wrong send time to appear
    expect(sent.filter((s) => s.to === stopped)).toHaveLength(0);
  });

  it("🔴 a MULTI-SHOP phone gets exactly ONE SMS, naming no shop", async () => {
    const multi = freshPhone();
    await makeClient(shopA, multi);
    await makeClient(shopB, multi);
    await post("/api/rewards-recovery/challenge", { phone: multi });
    await settle(() => sent.some((s) => s.to === multi));
    const mine = sent.filter((s) => s.to === multi);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).not.toMatch(/Alpha|Bravo/);
  });

  it("verify failures are one body for wrong, replayed and never-issued", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => sent.some((s) => s.to === phone));
    const code = codeFor(phone);
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

describe("the one-segment production SMS", () => {
  // GSM-7 basic character set (3GPP TS 23.038). Anything outside it - or in
  // the extension table - would shrink or split the segment.
  const GSM7 =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

  it("🔴 is exactly one GSM-7 segment, with the door and nothing person-shaped", () => {
    const body = recoverySmsBody("123456");
    for (const ch of body) {
      expect(GSM7.includes(ch), `not GSM-7: ${JSON.stringify(ch)}`).toBe(true);
    }
    expect(body.length).toBeLessThanOrEqual(160); // one segment
    expect(body).toContain("/my-rewards");
    expect(body).toContain("123456");
    expect(body).toContain("Expires in 5 minutes");
    expect(body).toMatch(/STOP/);
    // Nothing that identifies anyone or anything: no shop, no name, no token,
    // no phone, and no credential riding the URL.
    expect(body).not.toMatch(/Alpha|Bravo|Cust/);
    expect(body).not.toMatch(/\/r\//);
    expect(body).not.toMatch(/\+1\d{10}/);
    expect(body).not.toMatch(/my-rewards[/?#]\S/); // the URL carries NOTHING
  });
});

describe("one complete recovery costs exactly one SMS", () => {
  it("🔴 the NEW flow: challenge -> verify -> chooser -> select, one send total", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone);
    const b = await makeClient(shopB, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => sent.some((s) => s.to === phone));
    const v = await post("/api/rewards-recovery/verify", { phone, code: codeFor(phone) });
    const proof = v.body.proof as string;
    const chooser = await post("/api/rewards-recovery/shops", { proof });
    expect(chooser.body.shops).toHaveLength(2);
    const flat = JSON.stringify(chooser.body);
    expect(flat).not.toContain(a.magicToken);
    expect(flat).not.toContain(shopA);
    expect(flat).not.toContain(phone);
    const bravo = chooser.body.shops.find((s: { name: string }) => s.name === "Bravo Fades");
    const sel = await post("/api/rewards-recovery/select", {
      proof,
      selectionId: bravo.selectionId,
    });
    expect(sel.body.url).toContain(`/r/${b.magicToken}/rewards`);
    expect(sent.filter((s) => s.to === phone)).toHaveLength(1);
  });

  it("🔴 the LEGACY journey: one POST, ONE message carrying code + door, verified through the chooser", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    const res = await post("/api/rewards/resolve-by-phone", { phone });
    expect(res.body).toEqual({ ok: true });
    await settle(() => sent.some((s) => s.to === phone));

    const mine = sent.filter((s) => s.to === phone);
    expect(mine).toHaveLength(1);
    // The ONE message: the code AND the door, no shop, no rewards link.
    expect(mine[0]!.body).toContain("/my-rewards");
    expect(mine[0]!.body).toMatch(/\d{6}/);
    expect(mine[0]!.body).not.toMatch(/Alpha/);
    expect(mine[0]!.body).not.toContain("/r/");

    // The customer enters the phone and THAT code - no second SMS anywhere.
    const v = await post("/api/rewards-recovery/verify", { phone, code: codeFor(phone) });
    expect(v.body.verified).toBe(true);
    const chooser = await post("/api/rewards-recovery/shops", { proof: v.body.proof });
    expect(chooser.status).toBe(200);
    expect(chooser.body.shops.map((s: { name: string }) => s.name)).toEqual(["Alpha Fades"]);
    expect(sent.filter((s) => s.to === phone)).toHaveLength(1);
  });

  it("🔴 legacy known/unknown answer byte-identically", async () => {
    const known = freshPhone();
    await makeClient(shopA, known);
    const r1 = await post("/api/rewards/resolve-by-phone", { phone: known });
    const r2 = await post("/api/rewards/resolve-by-phone", { phone: freshPhone() });
    expect(r1.status).toBe(r2.status);
    expect(r1.body).toEqual(r2.body);
  });

  it("audits the send on the OLDEST textable row, never the most recently active", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone, { createdAt: new Date(Date.now() - 86_400_000) });
    await makeClient(shopB, phone, { lastVisitAt: new Date() });
    await post("/api/rewards/resolve-by-phone", { phone });
    await settle(async () => (await prisma.nudge.count({ where: { clientId: a.id } })) > 0);
    const nudge = await prisma.nudge.findFirst({ where: { clientId: a.id } });
    expect(nudge!.shopId).toBe(shopA);
  });
});

describe("one shared allowance across every door", () => {
  it("🔴 alternating legacy and new draws ONE cooldown budget - not two", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards/resolve-by-phone", { phone });
    await settle(() => sent.some((s) => s.to === phone));
    // Same phone, other door, inside the cooldown: nothing.
    await post("/api/rewards-recovery/challenge", { phone });
    await post("/api/rewards/resolve-by-phone", { phone });
    await post("/api/rewards-recovery/challenge", { phone });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.filter((s) => s.to === phone)).toHaveLength(1);
  });

  it("🔴 the MANAGER resend and self-serve share bounded totals, alternated across every entry point", async () => {
    const phone = freshPhone();
    const client = await makeClient(shopA, phone);
    // Self-serve first (any device, any entry point - same routes).
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => sent.some((s) => s.to === phone));
    expect(sent.filter((s) => s.to === phone)).toHaveLength(1);

    // Manager resend inside the 5-minute nudge-trail window: refused - the
    // recovery SMS audited onto the same loyalty trail, so the trails are one.
    const resend = await request(app)
      .post(`/api/dashboard/clients/${client.id}/rewards-link`)
      .set("Cookie", ownerCookieA);
    expect(resend.status).toBe(429);

    // Both self-serve doors inside the 60s cooldown: nothing.
    await post("/api/rewards/resolve-by-phone", { phone });
    await post("/api/rewards-recovery/challenge", { phone });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.filter((s) => s.to === phone)).toHaveLength(1);
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
    expect(sent.filter((s) => s.to === phone)).toHaveLength(0);
  });
});

describe("provider failure discipline", () => {
  const HOSTILE = {
    phone: "+19995550000",
    otp: "SECRET_OTP_999111",
    auth: "Authorization: Bearer SK_hostile_cred",
    sid: "twilio_sid_ACdeadbeef",
  };

  it("🔴 a hostile provider error reaches NO log line, and the Nudge carries only a fixed classification", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const infoSpy = vi.spyOn(logger, "info");
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        throw new Error(
          `provider exploded for ${HOSTILE.phone} otp=${HOSTILE.otp} body="ChairBack code" ${HOSTILE.auth} ${HOSTILE.sid}`,
        );
      },
    });
    try {
      await post("/api/rewards-recovery/challenge", { phone });
      await settle(async () => {
        const n = await prisma.nudge.findFirst({ where: { shopId: shopA, status: "FAILED" } });
        return Boolean(n);
      });
      const nudge = await prisma.nudge.findFirst({ where: { shopId: shopA, status: "FAILED" } });
      expect(nudge!.failedReason).toBe("send_failed");

      const everything = JSON.stringify([
        warnSpy.mock.calls,
        errorSpy.mock.calls,
        infoSpy.mock.calls,
      ]);
      for (const fragment of Object.values(HOSTILE)) {
        expect(everything).not.toContain(fragment);
      }
      // And no raw destination phone either.
      expect(everything).not.toContain(phone);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      __setMessageProviderForTests({
        channel: "SMS",
        send: async (input) => {
          sent.push(input);
          return { sid: `TEST${sent.length}`, status: "sent" };
        },
      });
    }
  });

  it("🔴 a provider timeout consumes the allowance and NEVER retries", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    let calls = 0;
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        calls += 1;
        throw new Error("ETIMEDOUT");
      },
    });
    try {
      await post("/api/rewards-recovery/challenge", { phone });
      await settle(async () =>
        Boolean(await prisma.nudge.findFirst({ where: { shopId: shopA, status: "FAILED" } })),
      );
      expect(calls).toBe(1); // exactly one dispatch, no retry
      // The allowance was spent: the row's send counter advanced anyway.
      const row = await prisma.phoneRecoveryCode.findFirst({
        where: { phoneHash: phoneDigest(phone), purpose: RECOVERY_PURPOSE },
      });
      expect(row!.sendCount).toBe(1);
    } finally {
      __setMessageProviderForTests({
        channel: "SMS",
        send: async (input) => {
          sent.push(input);
          return { sid: `TEST${sent.length}`, status: "sent" };
        },
      });
    }
  });
});

describe("nothing leaks into shared stores", () => {
  it("🔴 no raw phone in the recovery store, metric keys or budget keys", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    await settle(() => sent.some((s) => s.to === phone));
    const rows = await prisma.phoneRecoveryCode.findMany({});
    expect(JSON.stringify(rows)).not.toMatch(/\+1212555/);
    // Metric/budget keys are pure timestamps - never a phone, hash or IP.
    const counters = await prisma.rateLimitCounter.findMany({
      where: { key: { startsWith: "recSms:" } },
      select: { key: true },
    });
    expect(counters.length).toBeGreaterThan(0);
    for (const c of counters) {
      expect(c.key).toMatch(/^recSms:(budget|m):[a-z_]*:?[hd]:\d+$/);
    }
  });
});
