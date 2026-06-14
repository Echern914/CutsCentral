import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { earnPunchForVisit } from "../services/punch.js";

/**
 * Promotions end to end: kind-specific validation, live-window status, SMS
 * blasts through the audited pipeline (cap-aware, opt-out-safe), walk-in use
 * tracking, the extra-punches earn boost, and tenant isolation.
 */
const app = createApp();
const emailA = `pr-a-${randomToken(6)}@test.local`;
const emailB = `pr-b-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let shopIdA: string;
let clientOne: string;
const sentBodies: { to: string; body: string }[] = [];

async function signupAndShop(email: string, name: string): Promise<{ cookie: string; shopId: string }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Promo Tester", smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://promo.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, shopId: shop.body.id };
}

beforeAll(async () => {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sentBodies.push(input);
      return { sid: `SM-fake-${sentBodies.length}`, status: "queued" };
    },
  });

  const a = await signupAndShop(emailA, "Promo Cuts A");
  cookieA = a.cookie;
  shopIdA = a.shopId;
  const b = await signupAndShop(emailB, "Promo Cuts B");
  cookieB = b.cookie;

  // Two reachable (consented) clients + one opted out + one with no consent;
  // the last two must never get a blast.
  const mk = async (
    key: string,
    phone: string,
    optedOut = false,
    consented = true,
  ) =>
    forShop(shopIdA).client.upsert({
      where: { shopId_acuityClientKey: { shopId: shopIdA, acuityClientKey: key } },
      create: {
        acuityClientKey: key,
        magicToken: randomToken(),
        firstName: "Promo",
        phone,
        optedOut,
        smsConsentAt: consented ? new Date("2026-01-01T00:00:00Z") : null,
        smsConsentSource: consented ? "barber_attest" : null,
      },
      update: {},
    });
  clientOne = (await mk("tel:+13025550101", "+13025550101")).id;
  await mk("tel:+13025550102", "+13025550102");
  await mk("tel:+13025550103", "+13025550103", true);
  // Consented=false: textable phone, not opted out, but no consent on file.
  await mk("tel:+13025550104", "+13025550104", false, false);
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("promotions", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/promos");
    expect(res.status).toBe(401);
  });

  it("rejects a percent promo without its value", async () => {
    const res = await request(app)
      .post("/api/promos")
      .set("Cookie", cookieA)
      .send({ kind: "PERCENT_OFF", title: "Broken" });
    expect(res.status).toBe(400);
  });

  let promoId: string;

  it("creates a live percent-off promo with a code", async () => {
    const res = await request(app)
      .post("/api/promos")
      .set("Cookie", cookieA)
      .send({
        kind: "PERCENT_OFF",
        title: "Spring Special",
        description: "20% off weekday cuts",
        code: "SPRING20",
        percentOff: 20,
      });
    expect(res.status).toBe(201);
    promoId = res.body.id;

    const list = await request(app).get("/api/promos").set("Cookie", cookieA);
    const promo = list.body.promotions.find((p: { id: string }) => p.id === promoId);
    expect(promo.status).toBe("live");
    expect(promo.percentOff).toBe(20);
    expect(promo.code).toBe("SPRING20");
  });

  it("a future-dated promo is scheduled and cannot blast", async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await request(app)
      .post("/api/promos")
      .set("Cookie", cookieA)
      .send({ kind: "FREE_ADDON", title: "Hot Towel Week", startsAt: future });
    expect(res.status).toBe(201);

    const list = await request(app).get("/api/promos").set("Cookie", cookieA);
    const promo = list.body.promotions.find((p: { id: string }) => p.id === res.body.id);
    expect(promo.status).toBe("scheduled");

    const blast = await request(app)
      .post(`/api/promos/${res.body.id}/blast`)
      .set("Cookie", cookieA)
      .send({ audience: "all", dryRun: true });
    expect(blast.status).toBe(400);
    expect(blast.body.error).toBe("not_live");
  });

  it("dry-run blast counts the opted-in audience and respects the daily cap", async () => {
    // Cap of 1 with 2 eligible clients: preview must show the cap biting.
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ dailySendCap: 1 });

    const res = await request(app)
      .post(`/api/promos/${promoId}/blast`)
      .set("Cookie", cookieA)
      .send({ audience: "all", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(2); // opted-out client excluded
    expect(res.body.sent).toBe(1);
    expect(res.body.skippedCap).toBe(1);
    expect(res.body.dryRun).toBe(true);

    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ dailySendCap: 50 });
  });

  it("real blast texts every eligible client through the audited pipeline", async () => {
    const res = await request(app)
      .post(`/api/promos/${promoId}/blast`)
      .set("Cookie", cookieA)
      .send({ audience: "all" });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(2);
    expect(res.body.failed).toBe(0);

    // Write-ahead rows are SENT, tagged as promo, linked to the promotion.
    const rows = await prisma.nudge.findMany({
      where: { shopId: shopIdA, promotionId: promoId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "SENT" && r.kind === "promo")).toBe(true);

    // Compliance: every body carries the offer and the STOP line.
    expect(sentBodies.length).toBe(2);
    for (const m of sentBodies) {
      expect(m.body).toContain("Spring Special");
      expect(m.body).toContain("SPRING20");
      expect(m.body).toMatch(/reply stop/i);
    }

    const list = await request(app).get("/api/promos").set("Cookie", cookieA);
    const promo = list.body.promotions.find((p: { id: string }) => p.id === promoId);
    expect(promo.textsSent).toBe(2);
  });

  it("records a walk-in use against the promo", async () => {
    const res = await request(app)
      .post(`/api/promos/${promoId}/use`)
      .set("Cookie", cookieA)
      .send({ clientId: clientOne });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/promos").set("Cookie", cookieA);
    const promo = list.body.promotions.find((p: { id: string }) => p.id === promoId);
    expect(promo.timesUsed).toBe(1);
  });

  it("a live extra-punches promo boosts what visits earn", async () => {
    await request(app)
      .post("/api/promos")
      .set("Cookie", cookieA)
      .send({ kind: "EXTRA_PUNCHES", title: "Double Punch Week", extraPunches: 1 });

    const visit = await forShop(shopIdA).visit.upsert({
      where: {
        shopId_acuityAppointmentId: { shopId: shopIdA, acuityAppointmentId: "promo-v1" },
      },
      create: {
        clientId: clientOne,
        acuityAppointmentId: "promo-v1",
        status: "COMPLETED",
        scheduledAt: new Date(),
        serviceName: "Haircut",
      },
      update: {},
    });
    await earnPunchForVisit(
      { id: shopIdA, punchesPerVisit: 1 },
      clientOne,
      visit.id,
      "Haircut",
    );
    const entry = await prisma.punchLedger.findUnique({ where: { visitId: visit.id } });
    expect(entry?.punchesEarned).toBe(2); // 1 base + 1 promo
  });

  it("cross-tenant: shop B cannot see, edit, blast, or delete shop A's promo", async () => {
    const list = await request(app).get("/api/promos").set("Cookie", cookieB);
    expect(list.body.promotions).toHaveLength(0);

    const patch = await request(app)
      .patch(`/api/promos/${promoId}`)
      .set("Cookie", cookieB)
      .send({ title: "Hijacked" });
    expect(patch.status).toBe(404);

    const blast = await request(app)
      .post(`/api/promos/${promoId}/blast`)
      .set("Cookie", cookieB)
      .send({ dryRun: true });
    expect(blast.status).toBe(404);

    const del = await request(app)
      .delete(`/api/promos/${promoId}`)
      .set("Cookie", cookieB);
    expect(del.status).toBe(404);
  });

  it("pausing a promo takes it off the client page", async () => {
    const pause = await request(app)
      .patch(`/api/promos/${promoId}`)
      .set("Cookie", cookieA)
      .send({ active: false });
    expect(pause.status).toBe(200);

    const list = await request(app).get("/api/promos").set("Cookie", cookieA);
    const promo = list.body.promotions.find((p: { id: string }) => p.id === promoId);
    expect(promo.status).toBe("off");
  });
});
