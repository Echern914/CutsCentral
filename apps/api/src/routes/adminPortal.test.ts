import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Operator portal: the gate (only isAdmin sessions get in - a normal customer
 * 404s) and the comp toggle (flips a shop to full access independent of Stripe).
 */
const app = createApp();
// Lowercased: signup stores email.toLowerCase(), and randomToken (base64url)
// can include uppercase - so lookups by the raw value would miss the row.
const adminEmail = `admin-${randomToken(6)}@test.local`.toLowerCase();
const userEmail = `user-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let adminCookie: string;
let userCookie: string;
let targetShopId: string;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: shopName });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://admin.test" });
  expect(shop.status).toBe(201);
  return cookie;
}

beforeAll(async () => {
  adminCookie = await signupAndShop(adminEmail, "Admin Shop");
  userCookie = await signupAndShop(userEmail, "Normal Shop");
  // Promote the admin directly (no self-serve path exists, by design).
  await prisma.user.update({ where: { email: adminEmail }, data: { isAdmin: true } });
  const target = await prisma.shop.findFirst({
    where: { owner: { email: userEmail } },
  });
  targetShopId = target!.id;
});

afterAll(async () => {
  for (const email of [adminEmail, userEmail]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("admin portal gate", () => {
  it("404s for a non-admin session", async () => {
    const res = await request(app).get("/api/admin-portal/metrics").set("Cookie", userCookie);
    expect(res.status).toBe(404);
  });

  it("rejects a logged-out request", async () => {
    // requireUser runs first and 401s with no session; authenticated
    // non-admins get the existence-hiding 404 (asserted above).
    const res = await request(app).get("/api/admin-portal/metrics");
    expect(res.status).toBe(401);
  });

  it("serves metrics to an admin", async () => {
    const res = await request(app).get("/api/admin-portal/metrics").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.totalShops).toBeGreaterThanOrEqual(2);
    expect(typeof res.body.mrrEstimate).toBe("number");
  });

  it("lists shops with owner emails", async () => {
    const res = await request(app).get("/api/admin-portal/shops").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    const target = res.body.shops.find((s: { id: string }) => s.id === targetShopId);
    expect(target.ownerEmail).toBe(userEmail);
  });
});

describe("comp access toggle", () => {
  it("a non-admin cannot comp anyone", async () => {
    const res = await request(app)
      .post(`/api/admin-portal/shops/${targetShopId}/comp`)
      .set("Cookie", userCookie)
      .send({ compAccess: true });
    expect(res.status).toBe(404);
  });

  it("admin comps a shop and the flag is reflected back, then revokes it", async () => {
    const comp = await request(app)
      .post(`/api/admin-portal/shops/${targetShopId}/comp`)
      .set("Cookie", adminCookie)
      .send({ compAccess: true });
    expect(comp.status).toBe(200);
    expect(comp.body.compAccess).toBe(true);

    // The shop's own billing status reflects the comp (the dashboard reads this).
    const billing = await request(app).get("/api/billing").set("Cookie", userCookie);
    expect(billing.body.compAccess).toBe(true);
    expect(billing.body.hasAccess).toBe(true);

    // The admin shops list shows it comped too.
    const listed = await request(app).get("/api/admin-portal/shops").set("Cookie", adminCookie);
    const row = listed.body.shops.find((s: { id: string }) => s.id === targetShopId);
    expect(row.compAccess).toBe(true);

    // Revoke flips it back.
    const revoke = await request(app)
      .post(`/api/admin-portal/shops/${targetShopId}/comp`)
      .set("Cookie", adminCookie)
      .send({ compAccess: false });
    expect(revoke.status).toBe(200);
    expect(revoke.body.compAccess).toBe(false);
    const after = await request(app).get("/api/billing").set("Cookie", userCookie);
    expect(after.body.compAccess).toBe(false);
  });

  it("compAccess unlocks access independent of Stripe (pure check)", async () => {
    // The access-gate semantics with billing ENABLED are covered in
    // billing.test.ts; here we assert the comp branch directly so it's not
    // dependent on this file's billing-disabled env.
    const { hasActiveAccess } = await import("../billing/stripe.js");
    const lapsed = { subscriptionStatus: "canceled", trialEndsAt: new Date(0) };
    expect(hasActiveAccess(lapsed, { enabled: true })).toBe(false);
    expect(hasActiveAccess({ ...lapsed, compAccess: true }, { enabled: true })).toBe(true);
  });
});
