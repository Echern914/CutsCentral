import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Client self-serve SMS consent on the rewards page. An opt-in must make the
 * client textable (consent stamped, not opted out, phone on file) and be
 * first-wins (never overwrite an earlier consent source). Opt-out flips the
 * live gate without erasing the consent proof.
 */
const app = createApp();
const email = `consent-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let shopId: string;
let barberCookie: string;

async function signupAndShop(): Promise<void> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Consent", smsAttested: true });
  expect(signup.status).toBe(201);
  barberCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", barberCookie)
    .send({ name: "Consent Cuts", bookingUrl: "https://consent.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
}

/** Create a client and return its magicToken. */
async function mkClient(opts: {
  phone?: string | null;
  consentSource?: string | null;
  optedOut?: boolean;
}): Promise<string> {
  const token = randomToken();
  await forShop(shopId).client.upsert({
    where: {
      shopId_acuityClientKey: {
        shopId,
        acuityClientKey: `tel:${token}`,
      },
    },
    create: {
      acuityClientKey: `tel:${token}`,
      magicToken: token,
      firstName: "Test",
      phone: opts.phone ?? null,
      optedOut: opts.optedOut ?? false,
      smsConsentAt: opts.consentSource ? new Date("2026-01-01T00:00:00Z") : null,
      smsConsentSource: opts.consentSource ?? null,
    },
    update: {},
  });
  return token;
}

beforeAll(async () => {
  await signupAndShop();
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("rewards consent state", () => {
  it("reports needs_consent for a fresh client", async () => {
    const token = await mkClient({ phone: "+13025550201" });
    const res = await request(app).get(`/api/rewards/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.consent).toEqual({ state: "needs_consent", hasPhone: true });
  });

  it("reports needs_consent + hasPhone false when no phone on file", async () => {
    const token = await mkClient({ phone: null });
    const res = await request(app).get(`/api/rewards/${token}`);
    expect(res.body.consent).toEqual({ state: "needs_consent", hasPhone: false });
  });
});

describe("opt-in", () => {
  it("rejects when no phone on file and none supplied", async () => {
    const token = await mkClient({ phone: null });
    const res = await request(app).post(`/api/rewards/${token}/opt-in`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("needs_phone");
  });

  it("rejects an unparseable body phone", async () => {
    const token = await mkClient({ phone: null });
    const res = await request(app)
      .post(`/api/rewards/${token}/opt-in`)
      .send({ phone: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phone");
  });

  it("opts in with a supplied phone and stamps client_self_serve", async () => {
    const token = await mkClient({ phone: null });
    const res = await request(app)
      .post(`/api/rewards/${token}/opt-in`)
      .send({ phone: "(302) 555-0250" });
    expect(res.status).toBe(200);
    expect(res.body.consent.state).toBe("opted_in");

    const client = await prisma.client.findUnique({ where: { magicToken: token } });
    expect(client?.smsConsentAt).not.toBeNull();
    expect(client?.smsConsentSource).toBe("client_self_serve");
    expect(client?.phone).toBe("+13025550250"); // normalized to E.164
    expect(client?.optedOut).toBe(false);
  });

  it("opts in one-tap when a phone is already on file", async () => {
    const token = await mkClient({ phone: "+13025550251" });
    const res = await request(app).post(`/api/rewards/${token}/opt-in`).send({});
    expect(res.status).toBe(200);
    expect(res.body.consent.state).toBe("opted_in");
  });

  it("is first-wins: never overwrites an existing consent source", async () => {
    const token = await mkClient({
      phone: "+13025550252",
      consentSource: "acuity_intake",
    });
    const res = await request(app).post(`/api/rewards/${token}/opt-in`).send({});
    expect(res.status).toBe(200);
    const client = await prisma.client.findUnique({ where: { magicToken: token } });
    expect(client?.smsConsentSource).toBe("acuity_intake"); // unchanged
    expect(client?.smsConsentAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("opt-out", () => {
  it("flips optedOut without clearing the consent proof", async () => {
    const token = await mkClient({
      phone: "+13025550260",
      consentSource: "client_self_serve",
    });
    const res = await request(app).post(`/api/rewards/${token}/opt-out`).send({});
    expect(res.status).toBe(200);
    expect(res.body.consent.state).toBe("opted_out");

    const client = await prisma.client.findUnique({ where: { magicToken: token } });
    expect(client?.optedOut).toBe(true);
    expect(client?.smsConsentAt).not.toBeNull(); // proof retained

    // GET reflects opted_out even though consent is on file.
    const get = await request(app).get(`/api/rewards/${token}`);
    expect(get.body.consent.state).toBe("opted_out");
  });

  it("re-opt-in after opt-out clears optedOut without re-stamping consent", async () => {
    const token = await mkClient({
      phone: "+13025550261",
      consentSource: "barber_attest",
      optedOut: true,
    });
    const res = await request(app).post(`/api/rewards/${token}/opt-in`).send({});
    expect(res.status).toBe(200);
    expect(res.body.consent.state).toBe("opted_in");
    const client = await prisma.client.findUnique({ where: { magicToken: token } });
    expect(client?.optedOut).toBe(false);
    expect(client?.smsConsentSource).toBe("barber_attest"); // not re-stamped
  });
});

describe("unknown token", () => {
  it("404s on GET, opt-in, and opt-out", async () => {
    const bogus = "nonexistenttoken123";
    expect((await request(app).get(`/api/rewards/${bogus}`)).status).toBe(404);
    expect(
      (await request(app).post(`/api/rewards/${bogus}/opt-in`).send({})).status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/rewards/${bogus}/opt-out`).send({})).status,
    ).toBe(404);
  });
});

describe("STOP lock (optOutSource)", () => {
  /** Simulate an inbound Twilio keyword (signature bypassed under VITEST). */
  async function inbound(from: string, body: string) {
    return request(app)
      .post("/webhooks/twilio/inbound")
      .type("form")
      .send({ From: from, Body: body });
  }

  async function clientByToken(token: string) {
    return prisma.client.findUnique({ where: { magicToken: token } });
  }

  it("STOP stamps optOutSource=sms_stop; the dashboard cannot clear it", async () => {
    const phone = "+13025550270";
    const token = await mkClient({ phone, consentSource: "barber_attest" });
    const stop = await inbound(phone, "STOP");
    expect(stop.status).toBe(200);
    let client = await clientByToken(token);
    expect(client?.optedOut).toBe(true);
    expect(client?.optOutSource).toBe("sms_stop");

    // Barber "Opt back in" must be refused - re-contact after STOP is the
    // $500-1500/text TCPA scenario.
    const optIn = await request(app)
      .post(`/api/dashboard/clients/${client!.id}/opt`)
      .set("Cookie", barberCookie)
      .send({ optedOut: false });
    expect(optIn.status).toBe(409);
    expect(optIn.body.error).toBe("sms_stop_locked");
    client = await clientByToken(token);
    expect(client?.optedOut).toBe(true);
  });

  it("a barber-side opt-out stays barber-reversible", async () => {
    const token = await mkClient({ phone: "+13025550271" });
    const client = await clientByToken(token);
    const out = await request(app)
      .post(`/api/dashboard/clients/${client!.id}/opt`)
      .set("Cookie", barberCookie)
      .send({ optedOut: true });
    expect(out.status).toBe(200);
    expect((await clientByToken(token))?.optOutSource).toBe("barber");

    const backIn = await request(app)
      .post(`/api/dashboard/clients/${client!.id}/opt`)
      .set("Cookie", barberCookie)
      .send({ optedOut: false });
    expect(backIn.status).toBe(200);
    const after = await clientByToken(token);
    expect(after?.optedOut).toBe(false);
    expect(after?.optOutSource).toBeNull();
  });

  it("bulk optIn skips STOPped clients (and reports them) but clears the rest", async () => {
    const stopPhone = "+13025550272";
    const stoppedToken = await mkClient({ phone: stopPhone });
    await inbound(stopPhone, "STOP");
    // Legacy row: opted out before optOutSource existed (source null).
    const legacyToken = await mkClient({ phone: "+13025550273", optedOut: true });

    const stopped = await clientByToken(stoppedToken);
    const legacy = await clientByToken(legacyToken);
    const res = await request(app)
      .post("/api/dashboard/clients/bulk")
      .set("Cookie", barberCookie)
      .send({ action: "optIn", clientIds: [stopped!.id, legacy!.id] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1); // only the legacy row
    expect(res.body.lockedByStop).toBe(1);
    expect((await clientByToken(stoppedToken))?.optedOut).toBe(true);
    expect((await clientByToken(legacyToken))?.optedOut).toBe(false);
  });

  it("the client CAN clear their own STOP: START keyword or rewards opt-in", async () => {
    // Via START.
    const phoneA = "+13025550274";
    const tokenA = await mkClient({ phone: phoneA, consentSource: "acuity_intake" });
    await inbound(phoneA, "STOP");
    await inbound(phoneA, "START");
    const viaStart = await clientByToken(tokenA);
    expect(viaStart?.optedOut).toBe(false);
    expect(viaStart?.optOutSource).toBeNull();

    // Via rewards self-serve.
    const phoneB = "+13025550275";
    const tokenB = await mkClient({ phone: phoneB, consentSource: "acuity_intake" });
    await inbound(phoneB, "STOP");
    const res = await request(app).post(`/api/rewards/${tokenB}/opt-in`).send({});
    expect(res.status).toBe(200);
    const viaRewards = await clientByToken(tokenB);
    expect(viaRewards?.optedOut).toBe(false);
    expect(viaRewards?.optOutSource).toBeNull();
  });

  it("rewards self-serve opt-out records client_self_serve, not a STOP lock", async () => {
    const token = await mkClient({ phone: "+13025550276", consentSource: "manual" });
    const res = await request(app).post(`/api/rewards/${token}/opt-out`).send({});
    expect(res.status).toBe(200);
    expect((await clientByToken(token))?.optOutSource).toBe("client_self_serve");
  });
});
