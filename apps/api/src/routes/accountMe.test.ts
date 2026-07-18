import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";

/**
 * The account page's API surface: GET /me identity booleans (hasPassword /
 * hasGoogle / hasApple), PATCH /me profile fields (name, avatarUrl), and the
 * change-login-email flow (verify-the-new-inbox, single-use token, session
 * revocation). Mirrors passwordReset.test patterns where they overlap.
 */
const app = createApp();
const suffix = (randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "") + "z").slice(0, 8);
const emailStart = `acct-me-${suffix}@test.local`;
const emailNew = `acct-me-new-${suffix}@test.local`;
const emailTaken = `acct-me-taken-${suffix}@test.local`;
const password = "supersecret123";

afterEach(() => __setSendEmailForTests(undefined));

afterAll(async () => {
  for (const email of [emailStart, emailNew, emailTaken]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Account Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

describe("account identity + profile", () => {
  it("GET /me exposes sign-in method booleans, never the raw identifiers", async () => {
    const cookie = await signup(emailStart);
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.hasPassword).toBe(true);
    expect(me.body.hasGoogle).toBe(false);
    expect(me.body.hasApple).toBe(false);
    expect(me.body.avatarUrl).toBeNull();
    expect(me.body.passwordHash).toBeUndefined();
    expect(me.body.googleId).toBeUndefined();
    expect(me.body.appleId).toBeUndefined();

    // Linking a provider flips the boolean.
    await prisma.user.update({
      where: { email: emailStart },
      data: { googleId: `test-google-${suffix}` },
    });
    const linked = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(linked.body.hasGoogle).toBe(true);
  });

  it("PATCH /me saves and clears the avatar; rejects junk", async () => {
    const cookie = (await request(app)
      .post("/api/auth/login")
      .send({ email: emailStart, password })
      .then((r) => (r.headers["set-cookie"] as unknown as string[])[0]))!;

    const set = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", cookie)
      .send({ avatarUrl: "https://img.test/me.jpg" });
    expect(set.status).toBe(200);
    expect(set.body.avatarUrl).toBe("https://img.test/me.jpg");

    const cleared = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", cookie)
      .send({ avatarUrl: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.avatarUrl).toBeNull();

    // Not-a-URL and an empty patch both reject.
    const junk = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", cookie)
      .send({ avatarUrl: "javascript:alert(1)" });
    expect(junk.status).toBe(400);
    const empty = await request(app).patch("/api/auth/me").set("Cookie", cookie).send({});
    expect(empty.status).toBe(400);

    // Name still updates through the same route (the account page's name form).
    const named = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", cookie)
      .send({ name: "Renamed Tester" });
    expect(named.status).toBe(200);
    expect(named.body.name).toBe("Renamed Tester");
  });
});

describe("change login email", () => {
  it("is dark (503 + available:false) until email is configured", async () => {
    const avail = await request(app).get("/api/auth/email-change/available");
    expect(avail.body.available).toBe(false);

    const cookie = (await request(app)
      .post("/api/auth/login")
      .send({ email: emailStart, password })
      .then((r) => (r.headers["set-cookie"] as unknown as string[])[0]))!;
    const res = await request(app)
      .post("/api/auth/change-email")
      .set("Cookie", cookie)
      .send({ newEmail: emailNew, currentPassword: password });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_unavailable");
  });

  it("verifies the new inbox end-to-end: request -> emailed token -> confirm -> sessions revoked", async () => {
    const sent: SendEmailInput[] = [];
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: "test", status: "sent" };
    });

    const cookie = (await request(app)
      .post("/api/auth/login")
      .send({ email: emailStart, password })
      .then((r) => (r.headers["set-cookie"] as unknown as string[])[0]))!;

    // Wrong current password: same bar as change-password.
    const wrong = await request(app)
      .post("/api/auth/change-email")
      .set("Cookie", cookie)
      .send({ newEmail: emailNew, currentPassword: "not-my-password" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("wrong_password");

    // Changing to the current address is a no-op worth naming.
    const same = await request(app)
      .post("/api/auth/change-email")
      .set("Cookie", cookie)
      .send({ newEmail: emailStart, currentPassword: password });
    expect(same.status).toBe(400);
    expect(same.body.error).toBe("same_email");

    // Real request: generic ok + a confirmation email to the NEW address.
    const ok = await request(app)
      .post("/api/auth/change-email")
      .set("Cookie", cookie)
      .send({ newEmail: emailNew, currentPassword: password });
    expect(ok.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(emailNew);
    // Nothing changed yet - the pending address lives on the token, not User.
    expect(await prisma.user.findUnique({ where: { email: emailNew } })).toBeNull();

    const token = decodeURIComponent(
      sent[0]!.text.match(/confirm-email\?token=([^\s]+)/)![1]!,
    );

    // Confirm is public (the click may land in a session-less browser).
    const confirm = await request(app)
      .post("/api/auth/confirm-email-change")
      .send({ token });
    expect(confirm.status).toBe(200);

    // The login identity moved and every old session died (tokenVersion bump).
    expect(await prisma.user.findUnique({ where: { email: emailStart } })).toBeNull();
    const after = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: emailNew, password });
    expect(login.status).toBe(200);

    // Single-use: a replay of the same link is refused.
    const replay = await request(app)
      .post("/api/auth/confirm-email-change")
      .send({ token });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_or_expired");
  });

  it("answers an identical ok for a taken address and sends nothing (no enumeration)", async () => {
    const sent: SendEmailInput[] = [];
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: "test", status: "sent" };
    });

    await signup(emailTaken);
    const cookie = (await request(app)
      .post("/api/auth/login")
      .send({ email: emailNew, password })
      .then((r) => (r.headers["set-cookie"] as unknown as string[])[0]))!;

    const res = await request(app)
      .post("/api/auth/change-email")
      .set("Cookie", cookie)
      .send({ newEmail: emailTaken, currentPassword: password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("changing the password voids a pending email-change token (recovery revokes the session-independent way in)", async () => {
    const sent: SendEmailInput[] = [];
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: "test", status: "sent" };
    });

    const cookie = (await request(app)
      .post("/api/auth/login")
      .send({ email: emailNew, password })
      .then((r) => (r.headers["set-cookie"] as unknown as string[])[0]))!;

    const pendingEmail = `acct-me-pending-${suffix}@test.local`;
    const req1 = await request(app)
      .post("/api/auth/change-email")
      .set("Cookie", cookie)
      .send({ newEmail: pendingEmail, currentPassword: password });
    expect(req1.status).toBe(200);
    expect(sent).toHaveLength(1);
    const token = decodeURIComponent(
      sent[0]!.text.match(/confirm-email\?token=([^\s]+)/)![1]!,
    );

    // The documented intruder-recovery step: change the password. The pending
    // token is not a session, so the tokenVersion bump alone wouldn't kill it.
    const cp = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie)
      .send({ currentPassword: password, newPassword: `${password}-rotated` });
    expect(cp.status).toBe(200);

    const confirm = await request(app)
      .post("/api/auth/confirm-email-change")
      .send({ token });
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toBe("invalid_or_expired");
    // The login identity never moved.
    expect(await prisma.user.findUnique({ where: { email: pendingEmail } })).toBeNull();
  });
});
