import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The per-shop custom visit-noun (Shop.serviceNoun). A loctician on a "barber"
 * shop says "twist", not "cut" — the custom word must win everywhere the noun
 * surfaces (settings echo, /api/auth/me resolved noun, SMS preview), and a
 * blank save must CLEAR it back to the industry default.
 */
const app = createApp();
const email = `noun-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let slug: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "N", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Locs & Co", industry: "barber", smsAttested: true });
  expect(shop.status).toBe(201);
  slug = shop.body.slug;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Shop.serviceNoun", () => {
  it("saves trimmed + lowercased, echoes on PATCH and GET /api/shops/me", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ serviceNoun: "  Twist " });
    expect(patch.status).toBe(200);
    expect(patch.body.serviceNoun).toBe("twist");

    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(me.body.serviceNoun).toBe("twist");
  });

  it("/api/auth/me resolves the noun custom-first", async () => {
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.serviceNoun).toBe("twist");
  });

  it("the SMS preview default template uses the custom noun", async () => {
    const res = await request(app)
      .post("/api/shops/me/sms-preview")
      .set("Cookie", cookie)
      .send({ template: null });
    expect(res.status).toBe(200);
    expect(res.body.preview).toContain("last twist");
    expect(res.body.preview).not.toContain("last cut");
  });

  it("the public page payload carries the custom noun", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ publicPageEnabled: true });
    const page = await request(app).get(`/api/page/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body.serviceNoun).toBe("twist");
  });

  it("a blank save clears back to the industry default", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ serviceNoun: "" });
    expect(patch.status).toBe(200);
    expect(patch.body.serviceNoun).toBeNull();

    // Resolved noun falls back to the industry word ("cut" for barber default).
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.body.serviceNoun).toBe("cut");
  });

  it("rejects a noun over 24 chars", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ serviceNoun: "x".repeat(25) });
    expect(patch.status).toBe(400);
  });
});
