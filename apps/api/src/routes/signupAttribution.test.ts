import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Acquisition attribution on signup: the marketing blob the web middleware
 * captured into a first-party cookie is forwarded by the signup action and
 * persisted onto User.acquisition, with the referral code split into its own
 * indexed User.referralCode column (for affiliate reporting). A signup with no
 * attribution stores null for both. Unknown keys are stripped, not rejected.
 */
const app = createApp();
const emails: string[] = [];

function freshEmail(tag: string): string {
  const e = `attn-${tag}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(e);
  return e;
}

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

describe("signup acquisition attribution", () => {
  it("persists the acquisition blob and pulls the referral code into its column", async () => {
    const email = freshEmail("full");
    const res = await request(app)
      .post("/api/auth/signup")
      .send({
        email,
        password: "supersecret123",
        name: "Attributed Barber",
        smsAttested: true,
        acquisition: {
          utm_source: "meta",
          utm_campaign: "spring-fades",
          fbclid: "abc123",
          landingPath: "/for/barbers",
        },
        referralCode: "drick",
      });
    expect(res.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.referralCode).toBe("drick");
    expect(user?.acquisition).toMatchObject({
      utm_source: "meta",
      utm_campaign: "spring-fades",
      fbclid: "abc123",
      landingPath: "/for/barbers",
    });
  });

  it("stores null attribution for an organic signup", async () => {
    const email = freshEmail("organic");
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "supersecret123", name: "Organic", smsAttested: true });
    expect(res.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.acquisition).toBeNull();
    expect(user?.referralCode).toBeNull();
  });

  it("strips unknown attribution keys instead of rejecting the signup", async () => {
    const email = freshEmail("unknown");
    const res = await request(app)
      .post("/api/auth/signup")
      .send({
        email,
        password: "supersecret123",
        name: "Unknown Keys",
        smsAttested: true,
        acquisition: { utm_source: "google", evil: "x".repeat(9999), nope: "drop" },
      });
    expect(res.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.acquisition).toEqual({ utm_source: "google" });
  });

  it("still rejects a signup missing the SMS attestation, attribution or not", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({
        email: freshEmail("noattest"),
        password: "supersecret123",
        name: "No Attest",
        acquisition: { utm_source: "meta" },
      });
    expect(res.status).toBe(400);
  });
});
