import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * 🔴 DELETE SHOP ACCEPTS THE NAME AS AN iPHONE TYPES IT.
 *
 * iOS capitalises the first letter and predictive text adds a trailing space,
 * and the exact match refused "Cherncuts " for "cherncuts" while the screen
 * showed a perfect match. Same rule as deleting an account: ignore case and
 * the surrounding space - still the shop's own name, nothing looser.
 */
const app = createApp();
const email = `shop-del-${randomToken(6)}@test.local`.toLowerCase();

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

describe("DELETE /api/shops/me", () => {
  it("refuses another name, and accepts the shop's own name in any case with a trailing space", async () => {
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "supersecret123", name: "D", smsAttested: true });
    expect(signup.status).toBe(201);
    const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    const shop = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "cherncuts", bookingUrl: "https://d.test", smsAttested: true });
    expect(shop.status).toBe(201);

    const wrong = await request(app).delete("/api/shops/me").set("Cookie", cookie).send({ confirm: "chern cuts" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("confirm_mismatch");

    const iphone = await request(app).delete("/api/shops/me").set("Cookie", cookie).send({ confirm: "Cherncuts " });
    expect(iphone.status).toBe(200);
    expect(await prisma.shop.findUnique({ where: { id: shop.body.id as string } })).toBeNull();
  });
});
