import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * THE PRODUCTION STATE, PINNED: the appointment pass type is NOT configured.
 *
 * `appointmentWalletFlag.test.ts` proves the wiring works once the certificates
 * exist. This suite proves the opposite and far more important case — the one
 * every shop is actually in today — is FAIL-CLOSED in all four ways:
 *
 *   1. no badge            — walletPass.appointment / wallet.appointment are false;
 *   2. no broken download  — a REAL booked appointment's pass URL answers 404
 *                            JSON, never a truncated or unsigned .pkpass;
 *   3. no 500              — the refusal is a deliberate 404, not an exception
 *                            escaping the signer;
 *   4. no collateral       — the LOYALTY pass is untouched and still advertises
 *                            itself, in the same payload, at the same moment.
 *
 * 🔴 THE PUNCH CARD IS CONFIGURED HERE AND THE APPOINTMENT PASS IS NOT. That
 * split is the entire point: it is the only arrangement in which "turning the
 * appointment pass off did not disturb loyalty" is a claim a test can make.
 *
 * 🔴 THE APPT VARS ARE DELETED, NOT MERELY LEFT UNSET. Vitest reuses a worker
 * process across files, so `appointmentWalletFlag.test.ts` running first in the
 * same worker would leak its env in and this whole suite would silently assert
 * the wrong state. Deleting makes the file's meaning independent of test order.
 */
delete process.env.WALLET_APPT_PASS_TYPE_ID;
delete process.env.WALLET_APPT_PASS_CERT_BASE64;
delete process.env.WALLET_APPT_PASS_KEY_BASE64;
delete process.env.WALLET_APPT_PASS_KEY_PASSPHRASE;

// The punch card, by contrast, IS configured - see the header.
process.env.WALLET_PASS_TYPE_ID = "pass.test.chairback";
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_PASS_CERT_BASE64 = Buffer.from("test-cert").toString("base64");
process.env.WALLET_PASS_KEY_BASE64 = Buffer.from("test-key").toString("base64");
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from("test-wwdr").toString("base64");

const { createApp } = await import("../app.js");
const { appointmentWalletEnabled } = await import("../wallet/appointmentPass.js");
const { walletEnabled } = await import("../wallet/pass.js");
const { pokeAppointmentPass } = await import("../wallet/appointmentPass.js");

const app = createApp();
const email = `apptdark-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let appointmentId: string;
const manageToken = randomToken();
const magicToken = randomToken();

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Dark Wallet", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Dark Cuts", bookingUrl: "https://dark.test", smsAttested: true });
  expect(shop.status).toBe(201);

  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })
    ).status,
  ).toBe(200);

  // Rewards ON, so the loyalty pass really does advertise itself below.
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ rewardsEnabled: true })
    ).status,
  ).toBe(200);

  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Dee" });
  expect(staff.status).toBe(201);

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 45, staffIds: [staff.body.id] });
  expect(service.status).toBe(201);

  // A REAL, BOOKED appointment - so a 404 below is attributable to the gate and
  // not to a row that was never there.
  const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.body.id,
      serviceId: service.body.id,
      firstName: "Ada",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken,
    },
    select: { id: true },
  });
  appointmentId = appt.id;

  await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1555${randomToken(7)}`,
      magicToken,
      firstName: "Ada",
    },
  });
});

describe("the appointment pass is dark, and says so honestly", () => {
  it("sanity: appointment pass OFF, punch card ON", () => {
    // Without this the suite could pass by having configured nothing at all.
    expect(appointmentWalletEnabled()).toBe(false);
    expect(walletEnabled()).toBe(true);
  });

  it("1. NO BADGE — the booking page is told not to offer it", async () => {
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.walletPass.appointment).toBe(false);
  });

  it("1. NO BADGE — the customer's home is told the same", async () => {
    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet.appointment).toBe(false);
  });

  it("2+3. NO BROKEN DOWNLOAD, NO 500 — a real booked appointment answers 404", async () => {
    const res = await request(app).get(`/api/book/manage/${manageToken}/wallet-pass`);
    // 🔴 404, deliberately - not 500, and not a half-built pass.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
    expect(res.body).toEqual({ error: "not_found" });
    expect(res.headers["content-type"] ?? "").not.toContain("apple.pkpass");
  });

  it("3. NO 500 — the reschedule hook is a no-op rather than a throw", async () => {
    // This runs on EVERY reschedule in production right now. It must not throw
    // and must not reject, or a wallet problem becomes a booking failure.
    await expect(pokeAppointmentPass(appointmentId)).resolves.toBe("nothing_to_do");
  });

  it("4. NO COLLATERAL — the loyalty pass still advertises itself", async () => {
    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    // The whole claim, in one object: loyalty live, appointment dark.
    expect(res.body.wallet).toEqual({ available: true, appointment: false });
  });
});
