import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { createApp } from "../app.js";

/**
 * Forgot/reset password flow. Emails go through the injected test sender (which
 * also flips emailEnabled() on - the flow is dark without it), so we can assert
 * on the emailed link and pull the raw token out of it. Covers: no user
 * enumeration, hash-only storage, supersede-on-re-request, the full reset happy
 * path (old password dead, all sessions revoked, token single-use), expiry, and
 * the disabled (no email env) no-op.
 */

const app = createApp();
const email = `pwreset-${Date.now()}@test.local`;
const password = "originalpass123";
const newPassword = "brandnewpass456";

let sent: SendEmailInput[] = [];
let cookie: string;
let userId: string;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Pull the raw token out of the emailed reset link. */
function tokenFromEmail(text: string): string {
  const match = /reset-password\?token=([A-Za-z0-9_\-%]+)/.exec(text);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: `EM${sent.length}`, status: "sent" };
  });
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Reset Tester", smsAttested: true });
  expect(res.status).toBe(201);
  userId = res.body.id as string;
  cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.user.deleteMany({ where: { email } }); // reset tokens cascade
  await prisma.$disconnect();
});

describe("password reset flow", () => {
  it("reports available while the (test) email sender is configured", async () => {
    const res = await request(app).get("/api/auth/password-reset/available");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it("rejects a malformed email with 400 (schema, not enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("answers 200 for an unknown email and mints NOTHING", async () => {
    const before = await prisma.passwordResetToken.count();
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `nobody-${Date.now()}@test.local` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent.length).toBe(0);
    expect(await prisma.passwordResetToken.count()).toBe(before);
  });

  it("mints a hashed single token + emails the link for a real account", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true }); // identical body to the unknown case

    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe(email);
    const raw = tokenFromEmail(sent[0]!.text);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId } });
    expect(rows.length).toBe(1);
    // Only the sha256 is stored - never the raw token from the link.
    expect(rows[0]!.tokenHash).toBe(sha256Hex(raw));
    expect(rows[0]!.tokenHash).not.toBe(raw);
    expect(rows[0]!.usedAt).toBeNull();
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a re-request supersedes the earlier token (old link goes dead)", async () => {
    const firstRaw = tokenFromEmail(sent[0]!.text);

    const res = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(res.status).toBe(200);
    expect(sent.length).toBe(2);

    // Still exactly one live token - the first was deleted, not accumulated.
    const rows = await prisma.passwordResetToken.findMany({
      where: { userId, usedAt: null },
    });
    expect(rows.length).toBe(1);

    // And the superseded link no longer works.
    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: firstRaw, newPassword });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_or_expired");
  });

  it("resets the password: old password dead, sessions revoked, token spent", async () => {
    // The pre-reset session works right up until the reset...
    const before = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(before.status).toBe(200);

    const raw = tokenFromEmail(sent[1]!.text);
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, newPassword });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true }); // no auto-login: no set-cookie session

    // Old password rejected, new one accepted.
    const oldLogin = await request(app).post("/api/auth/login").send({ email, password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);

    // ...and the tokenVersion bump revoked the pre-reset session everywhere.
    const after = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(after.status).toBe(401);

    // Single-use: replaying the same link is refused.
    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, newPassword: "yetanotherpass789" });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_or_expired");
  });

  it("rejects an expired token", async () => {
    const raw = randomToken();
    await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: sha256Hex(raw),
        expiresAt: new Date(Date.now() - 1000), // already lapsed
      },
    });
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, newPassword });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_or_expired");
  });

  it("rejects a too-short new password", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: randomToken(), newPassword: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("goes dark without email: unavailable, and no token is minted", async () => {
    __setSendEmailForTests(undefined); // back to real env = no RESEND vars in tests
    try {
      const avail = await request(app).get("/api/auth/password-reset/available");
      expect(avail.body.available).toBe(false);

      const before = await prisma.passwordResetToken.count({ where: { userId } });
      const res = await request(app).post("/api/auth/forgot-password").send({ email });
      expect(res.status).toBe(200); // still the generic 200 - just a no-op
      expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(before);
    } finally {
      __setSendEmailForTests(async (input) => {
        sent.push(input);
        return { id: `EM${sent.length}`, status: "sent" };
      });
    }
  });
});
