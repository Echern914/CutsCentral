import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { createDashboardLink } from "../billing/connect.js";

/**
 * POST /api/payments/connect/dashboard - the door to the barber's own money.
 *
 * An Express account (set up through ChairBack) has no login at stripe.com;
 * the only way into its balance and payouts is a one-time link the platform
 * mints. Minting needs a live Stripe key, which the test environment does not
 * have, so what is pinned here is every refusal AND the Standard branch, which
 * never talks to Stripe at all.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

async function makeOwner(label: string) {
  const email = `dash-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Dash", smsAttested: true });
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

describe("POST /api/payments/connect/dashboard", () => {
  it("refuses an anonymous caller", async () => {
    const res = await request(app).post("/api/payments/connect/dashboard");
    expect(res.status).toBe(401);
  });

  it("is dark while Connect is unconfigured, never a half-built link", async () => {
    const { cookie } = await makeOwner("Dash Dark");
    const res = await request(app)
      .post("/api/payments/connect/dashboard")
      .set("Cookie", cookie);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("connect_disabled");
    expect(res.body.url).toBeUndefined();
  });
});

describe("createDashboardLink", () => {
  it("a STANDARD account is the barber's own login - plain dashboard.stripe.com, no Stripe call", async () => {
    // Stripe refuses login links for Standard accounts; the test env has no
    // key at all, so reaching Stripe here would throw. It must not.
    const url = await createDashboardLink({
      stripeConnectAccountId: "acct_standard_test",
      stripeConnectAccountType: "standard",
    });
    expect(url).toBe("https://dashboard.stripe.com/");
  });

  it("an EXPRESS account needs a minted link, so it goes to Stripe (and fails honestly without a key)", async () => {
    await expect(
      createDashboardLink({
        stripeConnectAccountId: "acct_express_test",
        stripeConnectAccountType: "express",
      }),
    ).rejects.toThrow();
  });
});
