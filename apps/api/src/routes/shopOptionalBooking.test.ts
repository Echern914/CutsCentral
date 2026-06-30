import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A shop may be created with NO booking link (barbers not on Acuity/Square/etc).
 * The booking link is optional: omitted/blank -> stored as null, and a provided
 * value must still be a valid http(s) URL.
 */
const app = createApp();
const password = "supersecret123";

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "NoLink", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

const emails: string[] = [];

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("shop create — optional booking link", () => {
  it("creates a shop with NO bookingUrl (stored as null)", async () => {
    const email = `nolink-${randomToken(6)}@test.local`;
    emails.push(email);
    const cookie = await signup(email);
    const res = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "No Link Cuts", smsAttested: true }); // bookingUrl omitted
    expect(res.status).toBe(201);
    const shop = await prisma.shop.findUnique({ where: { id: res.body.id } });
    expect(shop?.bookingUrl).toBeNull();
  });

  it("treats an empty-string bookingUrl as null", async () => {
    const email = `blanklink-${randomToken(6)}@test.local`;
    emails.push(email);
    const cookie = await signup(email);
    const res = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Blank Link Cuts", bookingUrl: "", smsAttested: true });
    expect(res.status).toBe(201);
    const shop = await prisma.shop.findUnique({ where: { id: res.body.id } });
    expect(shop?.bookingUrl).toBeNull();
  });

  it("still stores and requires a valid URL when one IS provided", async () => {
    const email = `goodlink-${randomToken(6)}@test.local`;
    emails.push(email);
    const cookie = await signup(email);
    const ok = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Good Link Cuts", bookingUrl: "https://book.example.com", smsAttested: true });
    expect(ok.status).toBe(201);
    const shop = await prisma.shop.findUnique({ where: { id: ok.body.id } });
    expect(shop?.bookingUrl).toBe("https://book.example.com");
  });

  it("rejects a non-URL booking link (XSS guard still applies)", async () => {
    const email = `badlink-${randomToken(6)}@test.local`;
    emails.push(email);
    const cookie = await signup(email);
    const res = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Bad Link Cuts", bookingUrl: "javascript:alert(1)", smsAttested: true });
    expect(res.status).toBe(400);
  });
});
