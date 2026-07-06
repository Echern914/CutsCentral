import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Account deletion (App Store 5.1.1(v)): DELETE /api/auth/me removes the User
 * row AND every shop it owns (with the shop's tenant data cascading), gated by
 * a typed email confirmation. Distinct from DELETE /api/shops/me, which keeps
 * the login identity alive.
 */
const app = createApp();
const email = `acct-del-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

afterAll(async () => {
  // Belt-and-suspenders: if a test failed before deletion, don't leak the user.
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

describe("DELETE /api/auth/me", () => {
  it("requires auth", async () => {
    const res = await request(app).delete("/api/auth/me").send({ confirm: "x" });
    expect(res.status).toBe(401);
  });

  it("deletes the user and every owned shop only on a typed email confirmation", async () => {
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email, password, name: "Deleter", smsAttested: true });
    expect(signup.status).toBe(201);
    const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

    const shop = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({
        name: "Deleter's Shop",
        bookingUrl: "https://delete.test",
        rewardLabel: "Free Cut",
        rewardThreshold: 10,
        smsAttested: true,
      });
    expect(shop.status).toBe(201);
    const shopId = shop.body.id as string;

    // Tenant data that must cascade away with the shop.
    const client = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: "Cascade" });
    expect(client.status).toBe(201);

    // The account card reads hasPassword to phrase its password section.
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.hasPassword).toBe(true);

    // Wrong confirmation: nothing happens.
    const wrong = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .send({ confirm: "not-the-email" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("confirm_mismatch");
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();

    // Right confirmation (case-insensitive): user, shop, and client all gone.
    const del = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .send({ confirm: email.toUpperCase() });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.shop.findUnique({ where: { id: shopId } })).toBeNull();
    expect(await prisma.client.findUnique({ where: { id: client.body.id } })).toBeNull();

    // The old session is dead (its user no longer exists).
    const after = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });
});
