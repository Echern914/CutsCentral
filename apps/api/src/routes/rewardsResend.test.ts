import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";

/**
 * Re-sending a client their rewards link, from the barber's side of the counter.
 *
 * The link IS the credential today, so a lost SMS is a lost punch card. This is
 * the two-tap recovery for a barber standing next to the customer - and it must
 * not become a way to text someone who said no.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let otherCookie: string;
let shopId: string;
let sent: SendMessageInput[] = [];

async function signupAndShop(label: string, shopName: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: shopName, smsAttested: true });
  return { cookie: c, shopId: shop.body.id as string };
}

/** A client who CAN be texted: has a number, opted in, not opted out. */
async function textableClient(over: Record<string, unknown> = {}): Promise<string> {
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName: "Marcus" });
  expect(created.status).toBe(201);
  await prisma.client.update({
    where: { id: created.body.id },
    data: {
      phone: `+1212555${String(1000 + emails.length * 7 + Math.floor(Math.random() * 900)).slice(-4)}`,
      smsConsentAt: new Date(),
      smsConsentSource: "barber_attest",
      optedOut: false,
      ...over,
    },
  });
  return created.body.id as string;
}

const resend = (id: string, c = cookie) =>
  request(app).post(`/api/dashboard/clients/${id}/rewards-link`).set("Cookie", c);

beforeAll(async () => {
  process.env.DRY_RUN = "true";
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `TEST${sent.length}`, status: "sent" };
    },
  });
  const a = await signupAndShop("rr-owner", "Resend Cuts");
  cookie = a.cookie;
  shopId = a.shopId;
  const b = await signupAndShop("rr-other", "Other Cuts");
  otherCookie = b.cookie;
});

afterEach(async () => {
  sent = [];
  // The cooldown reads the Nudge trail, so clear it between cases - and the
  // platform segment windows, which this route now draws on.
  await prisma.nudge.deleteMany({ where: { client: { shopId } } });
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

describe("resending a rewards link", () => {
  it("texts the client their link and records the send", async () => {
    const id = await textableClient();
    const res = await resend(id);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    // The link goes to the punch card, and carries THEIR token.
    const client = await prisma.client.findUnique({ where: { id } });
    expect(sent[0]!.body).toContain(`/r/${client!.magicToken}/rewards`);
    expect(sent[0]!.body).toMatch(/STOP/);
    // 🔴 The body is FIXED ASCII - no customer or shop name, which could
    // change the length or force UCS-2 and multiply the billable segments.
    expect(sent[0]!.body).not.toContain("Resend Cuts");
    expect(sent[0]!.body).not.toContain("Marcus");
    // Audited as a real Nudge - and the audit is REDACTED: the bearer URL
    // goes to the provider in memory, never into a history field.
    const nudge = await prisma.nudge.findFirst({ where: { clientId: id } });
    expect(nudge!.status).toBe("SENT");
    expect(nudge!.messageSid).toBeTruthy();
    expect(nudge!.body).toBe("Rewards access link");
    expect(nudge!.body).not.toContain(client!.magicToken);
  });

  it("🔴 parallel resends cannot exceed the client ceiling - the ledger lock serializes them", async () => {
    const id = await textableClient();
    // Eight at once, "different devices": the advisory lock on
    // nudge:<clientId> serializes the read-check-create, so the 5-minute
    // cooldown binds for everyone after the first winner. Exactly one send;
    // every loser is refused BEFORE provider dispatch.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resend(id)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    expect(sent).toHaveLength(1);
    expect(await prisma.nudge.count({ where: { clientId: id } })).toBe(1);
  });

  it("🔴 a hostile provider error survives NOWHERE - log, Nudge, response", async () => {
    const HOSTILE = "hostile +19995550000 otp=123456 Authorization: Bearer SK_x twilio_AC1";
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        throw new Error(HOSTILE);
      },
    });
    const { logger } = await import("../logger.js");
    const warnSpy = (await import("vitest")).vi.spyOn(logger, "warn");
    try {
      const id = await textableClient();
      const res = await resend(id);
      expect(res.status).toBe(502);
      expect(JSON.stringify(res.body)).not.toContain("hostile");
      const nudge = await prisma.nudge.findFirst({ where: { clientId: id } });
      expect(nudge!.status).toBe("FAILED");
      expect(nudge!.failedReason).toBe("send_failed");
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("hostile");
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("+19995550000");
    } finally {
      warnSpy.mockRestore();
      __setMessageProviderForTests({
        channel: "SMS",
        send: async (input) => {
          sent.push(input);
          return { sid: `TEST${sent.length}`, status: "sent" };
        },
      });
    }
  });

  it("🔴 refuses a client who texted STOP, and says only THEY can undo it", async () => {
    const id = await textableClient({ optedOut: true, optOutSource: "sms_stop" });
    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("opted_out");
    expect(res.body.message).toMatch(/only they can opt back in/i);
    expect(sent).toHaveLength(0);
  });

  it("🔴 refuses a client who never opted in - consent is not implied by having a number", async () => {
    const id = await textableClient({ smsConsentAt: null });
    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_consent");
    expect(sent).toHaveLength(0);
  });

  it("refuses a client with no mobile number, and says what to fix", async () => {
    const created = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: "Nophone" });
    const res = await resend(created.body.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_phone");
    expect(sent).toHaveLength(0);
  });

  it("🔴 rate limits per CLIENT, so a second barber cannot double-text them", async () => {
    const id = await textableClient();
    expect((await resend(id)).status).toBe(200);
    const again = await resend(id);
    expect(again.status).toBe(429);
    expect(again.body.error).toBe("too_soon");
    expect(sent).toHaveLength(1);
  });

  it("🔴 another shop's client is a plain 404, not a hint that it exists", async () => {
    const id = await textableClient();
    const res = await resend(id, otherCookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(sent).toHaveLength(0);
  });

  it("a failed send is recorded as FAILED and answers honestly", async () => {
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        throw new Error("carrier_down");
      },
    });
    const id = await textableClient();
    const res = await resend(id);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("send_failed");
    const nudge = await prisma.nudge.findFirst({ where: { clientId: id } });
    expect(nudge!.status).toBe("FAILED");
    __setMessageProviderForTests({
      channel: "SMS",
      send: async (input) => {
        sent.push(input);
        return { sid: "TESTOK", status: "sent" };
      },
    });
  });
});
