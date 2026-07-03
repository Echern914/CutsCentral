import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * Apple Wallet pass web service (PassKit protocol). These suites cover the
 * registration lifecycle + auth + pass-type gating. Actual .pkpass SIGNING is
 * not exercised here (it needs a real Apple Pass Type ID certificate) - the
 * routes under test all gate BEFORE any signing happens.
 *
 * The WALLET_* env is set before the app modules load (dynamic import below):
 * wallet/pass.ts and routes/wallet.ts freeze apiEnv() at module scope, so a
 * plain static import would have compiled them wallet-disabled.
 */
const PASS_TYPE = "pass.test.chairback";
process.env.WALLET_PASS_TYPE_ID = PASS_TYPE;
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_PASS_CERT_BASE64 = Buffer.from("test-cert").toString("base64");
process.env.WALLET_PASS_KEY_BASE64 = Buffer.from("test-key").toString("base64");
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from("test-wwdr").toString("base64");

const { createApp } = await import("../app.js");
const { passAuthToken } = await import("../wallet/pass.js");

const app = createApp();
const email = `wallet-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const DEVICE = `device-${randomToken(8)}`;
let cookie: string;
let clientId: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Wallet Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Wallet Cuts", bookingUrl: "https://wallet.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const client = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName: "Cardholder" });
  expect(client.status).toBe(201);
  clientId = client.body.id;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

function auth(serial: string): string {
  return `ApplePass ${passAuthToken(serial)}`;
}

describe("wallet pass web service", () => {
  it("404s on a foreign pass type id", async () => {
    const res = await request(app)
      .post(`/v1/devices/${DEVICE}/registrations/pass.someone.else/${clientId}`)
      .send({ pushToken: "t" });
    // Mounted under /api/wallet; also check the real mount.
    expect(res.status).toBe(404);
    const mounted = await request(app)
      .post(`/api/wallet/v1/devices/${DEVICE}/registrations/pass.someone.else/${clientId}`)
      .set("Authorization", auth(clientId))
      .send({ pushToken: "t" });
    expect(mounted.status).toBe(404);
  });

  it("rejects registration without the pass's authenticationToken", async () => {
    const res = await request(app)
      .post(`/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${clientId}`)
      .send({ pushToken: "apns-token-1" });
    expect(res.status).toBe(401);

    const wrong = await request(app)
      .post(`/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${clientId}`)
      .set("Authorization", "ApplePass not-the-token")
      .send({ pushToken: "apns-token-1" });
    expect(wrong.status).toBe(401);
  });

  it("registers a device (201), re-registers idempotently (200), and lists it", async () => {
    const first = await request(app)
      .post(`/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${clientId}`)
      .set("Authorization", auth(clientId))
      .send({ pushToken: "apns-token-1" });
    expect(first.status).toBe(201);

    const again = await request(app)
      .post(`/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${clientId}`)
      .set("Authorization", auth(clientId))
      .send({ pushToken: "apns-token-2" }); // refreshed token
    expect(again.status).toBe(200);

    const rows = await prisma.walletPassRegistration.findMany({
      where: { deviceLibraryIdentifier: DEVICE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe(clientId);
    expect(rows[0]!.pushToken).toBe("apns-token-2");

    // First sync (no passesUpdatedSince): every registered serial comes back.
    const list = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.serialNumbers).toEqual([clientId]);
    expect(typeof list.body.lastUpdated).toBe("string");

    // Nothing changed since the future: 204 No Content.
    const later = new Date(Date.now() + 60_000).toISOString();
    const upToDate = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}?passesUpdatedSince=${encodeURIComponent(later)}`,
    );
    expect(upToDate.status).toBe(204);
  });

  it("guards the pass download with the same token (before any signing)", async () => {
    const res = await request(app).get(
      `/api/wallet/v1/passes/${PASS_TYPE}/${clientId}`,
    );
    expect(res.status).toBe(401);
  });

  it("404s registration for a serial that is not a client", async () => {
    const ghost = "not-a-real-client-id";
    const res = await request(app)
      .post(`/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${ghost}`)
      .set("Authorization", auth(ghost))
      .send({ pushToken: "apns-token-3" });
    expect(res.status).toBe(404);
  });

  it("unregisters and then 404s the device's registration list", async () => {
    const del = await request(app)
      .delete(`/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${clientId}`)
      .set("Authorization", auth(clientId));
    expect(del.status).toBe(200);
    expect(
      await prisma.walletPassRegistration.count({
        where: { deviceLibraryIdentifier: DEVICE },
      }),
    ).toBe(0);

    const list = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${PASS_TYPE}`,
    );
    expect(list.status).toBe(404);
  });

  it("accepts device logs", async () => {
    const res = await request(app)
      .post("/api/wallet/v1/log")
      .send({ logs: ["pass render failed on device X"] });
    expect(res.status).toBe(200);
  });

  it("advertises wallet availability on the rewards payload", async () => {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { magicToken: true },
    });
    const res = await request(app).get(`/api/rewards/${client!.magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toEqual({ available: true });
  });
});
