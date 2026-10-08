import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * 🔴 THE BOOKING PAGE ONLY PROMISES A REMINDER TEXT THAT CAN GO.
 *
 * The booked screen said "We'll text you a reminder before your visit" to
 * every client who ticked the box, with texting switched off platform-wide.
 * `textReminders` is the shop half of appointmentNotify's skipReason: texting
 * on and Premium. The page adds the client half (consent and a phone).
 */
const app = createApp();
const emails: string[] = [];
let shopId: string;
let slug: string;

beforeAll(async () => {
  const email = `txtrem-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "T", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Text Reminder Shop", bookingUrl: "https://t.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC" });
  expect(patch.status).toBe(200);
  slug = patch.body.slug as string;
});

afterAll(async () => {
  process.env.SMS_ENABLED = "true";
  __resetEnvCacheForTests();
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

async function flagWith(smsEnabled: boolean): Promise<unknown> {
  process.env.SMS_ENABLED = smsEnabled ? "true" : "false";
  __resetEnvCacheForTests();
  const res = await request(app).get(`/api/book/${slug}`);
  expect(res.status).toBe(200);
  return res.body.shop.textReminders;
}

describe("textReminders on the public booking payload", () => {
  it("🔴 is false while texting is switched off", async () => {
    expect(await flagWith(false)).toBe(false);
  });

  it("is true while texting is on, for a shop with texts in its plan", async () => {
    expect(await flagWith(true)).toBe(true);
  });
});
