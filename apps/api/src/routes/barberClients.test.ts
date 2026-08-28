import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";

/**
 * The barber's own-clients surface. Two load-bearing properties:
 *
 * ISOLATION - "their clients" is derived server-side from the seat's chair
 * (a BOOKED or COMPLETED Appointment on it). A colleague's client is a plain
 * 404, phones come back masked, and no request parameter can widen the set.
 *
 * ONE ENGINE - the resend action is the SAME code path as the manager button,
 * so the cooldown, daily cap and platform budget hold across doors. The
 * cross-door cooldown test is the proof.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let ownerCookie: string;
let shopId: string;
let chairA: string;
let chairB: string;
let serviceId: string;
let barberACookie: string;
let barberBCookie: string;
let chairlessCookie: string;
let sent: SendMessageInput[] = [];

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

let phoneSeq = 4100;
/** A client who CAN be texted, created through the real dashboard route so the
 * row gets its magicToken and consent shape the production way. */
async function textableClient(
  firstName: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; phone: string }> {
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", ownerCookie)
    .send({ firstName });
  expect(created.status).toBe(201);
  const phone = `+1212555${phoneSeq++}`;
  await prisma.client.update({
    where: { id: created.body.id },
    data: {
      phone,
      smsConsentAt: new Date(),
      smsConsentSource: "barber_attest",
      optedOut: false,
      ...over,
    },
  });
  return { id: created.body.id as string, phone };
}

async function appointmentOn(
  staffId: string,
  clientId: string | null,
  status: "BOOKED" | "COMPLETED" | "CANCELED",
  hoursFromNow: number,
) {
  const startsAt = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Someone",
      status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(16),
    },
  });
}

const list = (c: string, q?: string) =>
  request(app)
    .get(`/api/barber/clients${q ? `?${q}` : ""}`)
    .set("Cookie", c);
const resend = (id: string, c: string) =>
  request(app).post(`/api/barber/clients/${id}/rewards-link`).set("Cookie", c);

beforeAll(async () => {
  process.env.DRY_RUN = "true";
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `TEST${sent.length}`, status: "sent" };
    },
  });

  const owner = await signup("bc-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Chair Clients Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC" });

  const a = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Dev" });
  chairA = a.body.id;
  const b = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Marcus" });
  chairB = b.body.id;
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA, chairB] });
  serviceId = svc.body.id;

  const barberA = await signup("bc-barber-a");
  barberACookie = barberA.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: barberA.userId, role: "BARBER", staffId: chairA },
  });
  const barberB = await signup("bc-barber-b");
  barberBCookie = barberB.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: barberB.userId, role: "BARBER", staffId: chairB },
  });
  const chairless = await signup("bc-chairless");
  chairlessCookie = chairless.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: chairless.userId, role: "BARBER", staffId: null },
  });
});

afterEach(async () => {
  sent = [];
  // The cooldown reads the Nudge trail; the platform breaker reads the
  // recSms windows. Both must reset between cases.
  await prisma.nudge.deleteMany({ where: { shopId } });
  await prisma.rateLimitCounter.deleteMany({
    where: { key: { startsWith: "recSms:" } },
  });
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

describe("the own-clients list", () => {
  it("shows exactly the clients with a BOOKED or COMPLETED appointment on their chair", async () => {
    const served = await textableClient("Served");
    const booked = await textableClient("Upcoming");
    const colleagues = await textableClient("NotMine");
    const canceledOnly = await textableClient("Canceled");
    await appointmentOn(chairA, served.id, "COMPLETED", -48);
    await appointmentOn(chairA, booked.id, "BOOKED", 24);
    await appointmentOn(chairB, colleagues.id, "COMPLETED", -24);
    await appointmentOn(chairA, canceledOnly.id, "CANCELED", -24);

    const res = await list(barberACookie);
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: { id: string }) => c.id);
    expect(ids).toContain(served.id);
    expect(ids).toContain(booked.id);
    expect(ids).not.toContain(colleagues.id);
    expect(ids).not.toContain(canceledOnly.id);
  });

  it("masks every phone - the full number never appears anywhere in the response", async () => {
    const c = await textableClient("Masked");
    await appointmentOn(chairA, c.id, "COMPLETED", -2);
    const res = await list(barberACookie);
    const row = res.body.clients.find((r: { id: string }) => r.id === c.id);
    expect(row.maskedPhone).toBe(`··· ${c.phone.slice(-4)}`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(c.phone);
    expect(raw).not.toContain(c.phone.slice(1)); // digits-only form too
  });

  it("ignores a staffId query param - the chair is the seat's, full stop", async () => {
    const mine = await textableClient("StillMine");
    await appointmentOn(chairA, mine.id, "COMPLETED", -3);
    const res = await list(barberACookie, `staffId=${chairB}`);
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: { id: string }) => c.id);
    expect(ids).toContain(mine.id);
  });

  it("answers a chairless seat (and the unseated owner) with a reason, not a broken list", async () => {
    for (const cookie of [chairlessCookie, ownerCookie]) {
      const res = await list(cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ chair: null, clients: [], reason: "no_chair_linked" });
    }
  });

  it("excludes archived clients", async () => {
    const gone = await textableClient("Archived", { archivedAt: new Date() });
    await appointmentOn(chairA, gone.id, "COMPLETED", -5);
    const res = await list(barberACookie);
    const ids = res.body.clients.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(gone.id);
  });

  it("searches by name, and by phone digits without unmasking", async () => {
    const target = await textableClient("Zebediah");
    await appointmentOn(chairA, target.id, "COMPLETED", -6);

    const byName = await list(barberACookie, "q=zebed");
    expect(byName.body.clients.map((c: { id: string }) => c.id)).toContain(target.id);

    const byPhone = await list(barberACookie, `q=${target.phone.slice(-7)}`);
    expect(byPhone.body.clients.map((c: { id: string }) => c.id)).toContain(target.id);
    expect(JSON.stringify(byPhone.body)).not.toContain(target.phone);
  });

  it("lists an un-consented client as untextable with the reason", async () => {
    const quiet = await textableClient("NoConsent", { smsConsentAt: null });
    await appointmentOn(chairA, quiet.id, "COMPLETED", -7);
    const res = await list(barberACookie);
    const row = res.body.clients.find((r: { id: string }) => r.id === quiet.id);
    expect(row.textable).toBe(false);
    expect(row.reason).toBe("no_consent");
  });
});

describe("the own-client resend", () => {
  it("texts their rewards link, redacts the audit row", async () => {
    const c = await textableClient("Resendee");
    await appointmentOn(chairA, c.id, "COMPLETED", -8);
    const res = await resend(c.id, barberACookie);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const client = await prisma.client.findUnique({ where: { id: c.id } });
    expect(sent[0]!.body).toContain(`/r/${client!.magicToken}/rewards`);
    const nudge = await prisma.nudge.findFirst({ where: { clientId: c.id } });
    expect(nudge!.status).toBe("SENT");
    expect(nudge!.body).toBe("Rewards access link");
    expect(nudge!.body).not.toContain(client!.magicToken);
  });

  it("answers 404 for a colleague's client - indistinguishable from not existing", async () => {
    const theirs = await textableClient("TheirsOnly");
    await appointmentOn(chairB, theirs.id, "COMPLETED", -9);
    const res = await resend(theirs.id, barberACookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(sent).toHaveLength(0);
  });

  it("answers 404 for a client id that does not exist", async () => {
    const res = await resend("clnope00000000000000000000", barberACookie);
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("shares ONE cooldown ledger with the manager door", async () => {
    const c = await textableClient("SharedLedger");
    await appointmentOn(chairA, c.id, "COMPLETED", -10);
    // Manager sends first, through the dashboard route...
    const managerSend = await request(app)
      .post(`/api/dashboard/clients/${c.id}/rewards-link`)
      .set("Cookie", ownerCookie);
    expect(managerSend.status).toBe(200);
    // ...and the barber door is inside the SAME cooldown immediately.
    const res = await resend(c.id, barberACookie);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_soon");
    expect(sent).toHaveLength(1);
  });

  it("refuses an opted-out client with the consent answer, sending nothing", async () => {
    const stop = await textableClient("Stopped", {
      optedOut: true,
      optOutSource: "sms_stop",
    });
    await appointmentOn(chairA, stop.id, "COMPLETED", -11);
    const res = await resend(stop.id, barberACookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("opted_out");
    expect(res.body.message).toMatch(/STOP/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a chairless seat outright", async () => {
    const c = await textableClient("NoChairTarget");
    await appointmentOn(chairA, c.id, "COMPLETED", -12);
    const res = await resend(c.id, chairlessCookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_chair");
    expect(sent).toHaveLength(0);
  });

  it("sanitizes a hostile provider error - fixed classification, no phone or token anywhere", async () => {
    const c = await textableClient("Hostile");
    await appointmentOn(chairA, c.id, "COMPLETED", -13);
    const client = await prisma.client.findUnique({ where: { id: c.id } });
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        throw new Error(
          `Twilio rejected ${c.phone} body="rewards /r/${client!.magicToken}" Authorization: Basic QUJD`,
        );
      },
    });
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const res = await resend(c.id, barberACookie);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: "send_failed",
        message: "Couldn't send that text just now. Try again in a moment.",
      });
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain(c.phone);
      expect(logged).not.toContain(client!.magicToken);
      expect(logged).not.toContain("Authorization");
      const nudge = await prisma.nudge.findFirst({ where: { clientId: c.id } });
      expect(nudge!.status).toBe("FAILED");
      expect(nudge!.failedReason).toBe("send_failed");
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
});
