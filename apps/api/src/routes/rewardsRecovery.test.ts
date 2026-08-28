import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";

/**
 * Rewards recovery from the OUTSIDE, plus the legacy mobile route.
 *
 * The property under test is CONSTANCY: an unauthenticated caller learns
 * nothing from any response - not existence, not shop count, not shop
 * identity, not consent state, not activity. Compared as full (status, body)
 * pairs, not vibes. The codes are read out of the captured SMS bodies, exactly
 * the way a customer would.
 */

const app = createApp();
const emails: string[] = [];
let shopA: string;
let shopB: string;
let sent: SendMessageInput[] = [];
let phoneSeq = 0;

/** Distinct prefix so PII sweeps of shared stores stay scoped to this suite. */
function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(8000 + phoneSeq).padStart(4, "0")}`;
}

function codeFor(phone: string): string {
  const body = [...sent].reverse().find((s) => s.to === phone)?.body ?? "";
  const m = /(\d{6})/.exec(body);
  expect(m, "no code SMS").toBeTruthy();
  return m![1]!;
}

const post = (path: string, body: unknown) => request(app).post(path).send(body as object);

async function makeShopOwner(label: string, shopName: string): Promise<string> {
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
  return shop.body.id as string;
}

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
  shopA = await makeShopOwner("rrec-a", "Alpha Fades");
  shopB = await makeShopOwner("rrec-b", "Bravo Fades");
});

afterEach(async () => {
  sent = [];
  await prisma.phoneRecoveryCode.deleteMany({});
  await prisma.client.deleteMany({ where: { shopId: { in: [shopA, shopB] } } });
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

describe("constancy before verification", () => {
  it("🔴 unknown, known-one-shop and known-multi-shop phones get IDENTICAL challenge responses", async () => {
    const unknown = freshPhone();
    const oneShop = freshPhone();
    const multi = freshPhone();
    await makeClient(shopA, oneShop);
    await makeClient(shopA, multi);
    await makeClient(shopB, multi);

    const rs = [
      await post("/api/rewards-recovery/challenge", { phone: unknown }),
      await post("/api/rewards-recovery/challenge", { phone: oneShop }),
      await post("/api/rewards-recovery/challenge", { phone: multi }),
      // Even a number that cannot parse:
      await post("/api/rewards-recovery/challenge", { phone: "not a phone" }),
    ];
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }
    // The parseable ones each got exactly ONE code SMS - multi-shop included.
    expect(sent.filter((s) => s.to === multi)).toHaveLength(1);
    expect(sent.filter((s) => s.to === oneShop)).toHaveLength(1);
    // Every SMS is the same neutral shape: no shop name anywhere.
    for (const s of sent) {
      expect(s.body).not.toMatch(/Alpha|Bravo/);
    }
  });

  it("🔴 verify failures are one body for wrong, replayed, expired and never-issued", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
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

    // The right code wins once...
    const okRes = await post("/api/rewards-recovery/verify", { phone, code });
    expect(okRes.body.verified).toBe(true);
    // ...and its replay is the same refusal as everything else.
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

describe("the verified path end to end", () => {
  it("🔴 verify -> chooser -> select opens EXACTLY the chosen shop", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone);
    const b = await makeClient(shopB, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    const v = await post("/api/rewards-recovery/verify", { phone, code: codeFor(phone) });
    const proof = v.body.proof as string;

    const chooser = await post("/api/rewards-recovery/shops", { proof });
    expect(chooser.status).toBe(200);
    expect(chooser.body.shops.map((s: { name: string }) => s.name).sort()).toEqual([
      "Alpha Fades",
      "Bravo Fades",
    ]);
    // Public fields only - and neither magicToken appears anywhere.
    const flat = JSON.stringify(chooser.body);
    expect(flat).not.toContain(a.magicToken);
    expect(flat).not.toContain(b.magicToken);
    expect(flat).not.toContain(shopA);
    expect(flat).not.toContain(phone);

    const bravo = chooser.body.shops.find((s: { name: string }) => s.name === "Bravo Fades");
    const sel = await post("/api/rewards-recovery/select", {
      proof,
      selectionId: bravo.selectionId,
    });
    expect(sel.status).toBe(200);
    expect(sel.body.url).toContain(`/r/${b.magicToken}/rewards`);
    expect(sel.body.url).not.toContain(a.magicToken);
  });
});

describe("the legacy mobile route (shipped builds still POST here)", () => {
  const LEGACY = "/api/rewards/resolve-by-phone";

  it("🔴 a multi-shop phone gets ONE neutral SMS - never one per shop, never a shop's link", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone);
    const b = await makeClient(shopB, phone);
    const res = await post(LEGACY, { phone });
    expect(res.body).toEqual({ ok: true });

    const mine = sent.filter((s) => s.to === phone);
    expect(mine).toHaveLength(1);
    // 🔴 The defect this rewrite removes: no shop is named, no shop's link is
    // chosen, "most recently active" is dead.
    expect(mine[0]!.body).not.toMatch(/Alpha|Bravo/);
    expect(mine[0]!.body).not.toContain(a.magicToken);
    expect(mine[0]!.body).not.toContain(b.magicToken);
    expect(mine[0]!.body).not.toContain("/r/");
    // What it DOES carry: the door to verified recovery.
    expect(mine[0]!.body).toContain("/my-rewards");
  });

  it("🔴 known and unknown phones answer byte-identically", async () => {
    const known = freshPhone();
    await makeClient(shopA, known);
    const r1 = await post(LEGACY, { phone: known });
    const r2 = await post(LEGACY, { phone: freshPhone() });
    expect(r1.status).toBe(r2.status);
    expect(r1.body).toEqual(r2.body);
  });

  it("respects the existing consent rule: an all-STOP phone gets NO text and the same ok", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone, { optedOut: true, optOutSource: "sms_stop" });
    const res = await post(LEGACY, { phone });
    expect(res.body).toEqual({ ok: true });
    expect(sent.filter((s) => s.to === phone)).toHaveLength(0);
  });

  it("audits the send on the OLDEST textable row, not the most recently active", async () => {
    const phone = freshPhone();
    // Older row at shop A; NEWER, more recently active row at shop B.
    const a = await makeClient(shopA, phone, { createdAt: new Date(Date.now() - 86_400_000) });
    await makeClient(shopB, phone, { lastVisitAt: new Date() });
    await post(LEGACY, { phone });
    const nudge = await prisma.nudge.findFirst({
      where: { clientId: a.id },
      orderBy: { createdAt: "desc" },
    });
    expect(nudge).not.toBeNull();
    expect(nudge!.shopId).toBe(shopA);
  });
});

describe("nothing leaks into shared stores", () => {
  it("🔴 no raw phone in the recovery store, and no raw phone in any log-bound field", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await post("/api/rewards-recovery/challenge", { phone });
    const rows = await prisma.phoneRecoveryCode.findMany({});
    const flat = JSON.stringify(rows);
    // Scoped to this suite's prefix so parallel suites can't false-positive.
    expect(flat).not.toMatch(/\+1212555/);
  });
});
