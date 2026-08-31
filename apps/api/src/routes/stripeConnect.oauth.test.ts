import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { createConnectState, CONNECT_OAUTH_STATE_COOKIE } from "../billing/connectOauth.js";

/**
 * The STANDARD Connect door — linking a Stripe account the barber already owns.
 *
 * 🔴 WHAT MAKES THIS DIFFERENT FROM EVERY OTHER DASHBOARD ROUTE: /callback is
 * entered by Stripe redirecting a browser, so it carries NO session. The signed
 * state cookie is the entire basis for deciding which shop an `acct_…` is bound
 * to — i.e. which bank account a shop's card payments will land in from then on.
 * The refusals below are therefore the substance of the feature, not edge cases.
 *
 * The Stripe token exchange itself needs a live Connect platform and is verified
 * there; everything here is reachable with no Stripe credentials at all, which
 * is also the state of the test environment.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

async function makeOwner(label: string) {
  const email = `stdc-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Std", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://s.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  shopIds.push(shopId);
  return { cookie, shopId };
}

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("GET /api/payments/connect/oauth/start", () => {
  it("refuses an anonymous caller — never leaks a state cookie", async () => {
    const res = await request(app).get("/api/payments/connect/oauth/start");
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("sends the barber back with 'unavailable' while Standard is unconfigured", async () => {
    // The documented dark state: no STRIPE_CONNECT_CLIENT_ID means the second
    // door cannot work, so it must dead-end honestly rather than bounce the
    // barber to a Stripe error page.
    const { cookie } = await makeOwner("Std Unconfigured");
    const res = await request(app)
      .get("/api/payments/connect/oauth/start")
      .set("Cookie", cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connect=unavailable");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("GET /api/payments/connect/oauth/callback", () => {
  it("🔴 refuses when the returned state does not match the cookie", async () => {
    // The core CSRF case: a code delivered to a browser that never started the
    // flow. Accepting it would bind an attacker-chosen account to this shop.
    const res = await request(app)
      .get("/api/payments/connect/oauth/callback")
      .query({ code: "ac_test", state: "attacker-supplied" })
      .set("Cookie", [`${CONNECT_OAUTH_STATE_COOKIE}=something-else`]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_oauth_state");
  });

  it("🔴 refuses a self-consistent but UNSIGNED state", async () => {
    // Matching cookie and query is not enough — an attacker controls both. Only
    // the HMAC proves the state came from our /start.
    const forged = Buffer.from(
      JSON.stringify({ shopId: "shop_victim", nonce: "n", exp: 9_999_999_999 }),
      "utf8",
    ).toString("base64url");
    const res = await request(app)
      .get("/api/payments/connect/oauth/callback")
      .query({ code: "ac_test", state: forged })
      .set("Cookie", [`${CONNECT_OAUTH_STATE_COOKIE}=${forged}`]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_oauth_state");
  });

  it("🔴 refuses an EXPIRED state even though it is genuinely signed", async () => {
    const stale = createConnectState("shop_x", Math.floor(Date.now() / 1000) - 3600);
    const res = await request(app)
      .get("/api/payments/connect/oauth/callback")
      .query({ code: "ac_test", state: stale })
      .set("Cookie", [`${CONNECT_OAUTH_STATE_COOKIE}=${stale}`]);
    expect(res.status).toBe(400);
  });

  it("refuses a callback with no code at all", async () => {
    const state = createConnectState("shop_x", Math.floor(Date.now() / 1000));
    const res = await request(app)
      .get("/api/payments/connect/oauth/callback")
      .query({ state })
      .set("Cookie", [`${CONNECT_OAUTH_STATE_COOKIE}=${state}`]);
    expect(res.status).toBe(400);
  });

  it("treats the barber cancelling at Stripe as a calm outcome, not an error", async () => {
    // access_denied is someone changing their mind. A 400 or an error page here
    // would read as "ChairBack broke", which is both wrong and alarming.
    const res = await request(app)
      .get("/api/payments/connect/oauth/callback")
      .query({ error: "access_denied", error_description: "user denied" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connect=cancelled");
  });

  it("a signed state for a shop that no longer exists 404s rather than throwing", async () => {
    const state = createConnectState("shop_deleted_xyz", Math.floor(Date.now() / 1000));
    const res = await request(app)
      .get("/api/payments/connect/oauth/callback")
      .query({ code: "ac_test", state })
      .set("Cookie", [`${CONNECT_OAUTH_STATE_COOKIE}=${state}`]);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/payments/connect/oauth/disconnect", () => {
  it("refuses an anonymous caller", async () => {
    const res = await request(app).post("/api/payments/connect/oauth/disconnect");
    expect(res.status).toBe(401);
  });

  it("is idempotent when nothing is connected", async () => {
    const { cookie } = await makeOwner("Std Nothing");
    const res = await request(app)
      .post("/api/payments/connect/oauth/disconnect")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, disconnected: false });
  });

  it("🔴 clears the account, the type and both live flags", async () => {
    const { cookie, shopId } = await makeOwner("Std Connected");
    const acct = `acct_${randomToken(10)}`;
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        stripeConnectAccountId: acct,
        // "express" so no Stripe deauthorize is attempted - this exercises the
        // local clear, which is the half that actually stops charges.
        stripeConnectAccountType: "express",
        connectChargesEnabled: true,
        payoutsEnabled: true,
      },
    });

    const res = await request(app)
      .post("/api/payments/connect/oauth/disconnect")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, disconnected: true });

    const after = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(after!.stripeConnectAccountId).toBeNull();
    expect(after!.stripeConnectAccountType).toBeNull();
    expect(after!.connectChargesEnabled).toBe(false);
    expect(after!.payoutsEnabled).toBe(false);
  });

  it("🔴 disconnecting one shop leaves another shop's account untouched", async () => {
    const a = await makeOwner("Std A");
    const b = await makeOwner("Std B");
    const acctB = `acct_${randomToken(10)}`;
    await prisma.shop.update({
      where: { id: a.shopId },
      data: { stripeConnectAccountId: `acct_${randomToken(10)}`, stripeConnectAccountType: "express" },
    });
    await prisma.shop.update({
      where: { id: b.shopId },
      data: { stripeConnectAccountId: acctB, stripeConnectAccountType: "express" },
    });

    await request(app)
      .post("/api/payments/connect/oauth/disconnect")
      .set("Cookie", a.cookie)
      .expect(200);

    const afterB = await prisma.shop.findUnique({ where: { id: b.shopId } });
    expect(afterB!.stripeConnectAccountId).toBe(acctB);
  });
});
