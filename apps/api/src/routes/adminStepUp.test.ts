import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { prisma, runAsOwner } from "@chairback/db";
import { ADMIN_PASS_COOKIE_NAME, __resetEnvCacheForTests, randomToken } from "@chairback/config";
import type { SendEmailInput } from "../messaging/email.js";
import { totpCode, totpStep } from "../auth/totp.js";

/**
 * ADMIN TWO-STEP: the operator portal opens only for a session that passed a
 * second check - an authenticator code, or an emailed one - AND carries the
 * pass token that check handed out.
 *
 * The threat this pins: SESSION_SECRET leaks (it sits in the hosting
 * environment). Its holder can mint a session for the admin's user id - even a
 * byte-identical copy of the admin's own, by trying each second of its issue
 * time. Before this, that session WAS the portal.
 */

let app: Express;
// vitest.setup.ts turns the step off for the feature suites; THIS suite runs
// the app as production does, with it on.
const savedStepUp = process.env.ADMIN_STEP_UP_ENABLED;
const sent: SendEmailInput[] = [];
const emails: string[] = [];
const password = "supersecret123";

async function signup(label: string): Promise<{ email: string; cookie: string; userId: string }> {
  const email = `as-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { email, cookie, userId: user.id };
}

async function admin(label: string) {
  const u = await signup(label);
  await prisma.user.update({ where: { id: u.userId }, data: { isAdmin: true } });
  return u;
}

/** A second, independent session for the same account. */
async function loginAgain(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

const pass = (token: string) => `${ADMIN_PASS_COOKIE_NAME}=${token}`;
const get = (path: string, cookies: string[]) =>
  request(app).get(`/api/admin-portal${path}`).set("Cookie", cookies.join("; "));
const post = (path: string, cookies: string[], body: Record<string, unknown> = {}) =>
  request(app).post(`/api/admin-portal${path}`).set("Cookie", cookies.join("; ")).send(body);

function lastCodeFor(email: string): string {
  const mail = [...sent].reverse().find((m) => m.to === email && /admin code/.test(m.subject));
  return /(\d{6})/.exec(mail?.subject ?? "")?.[1] ?? "";
}

/** Email-code a session through; returns its pass token. */
async function passByEmail(email: string, session: string): Promise<string> {
  expect((await post("/step-up/email/start", [session])).status).toBe(200);
  const ok = await post("/step-up/email/verify", [session], { code: lastCodeFor(email) });
  expect(ok.status).toBe(200);
  return ok.body.passToken as string;
}

beforeAll(async () => {
  process.env.RESEND_API_KEY = "re_test_dummy";
  process.env.EMAIL_FROM = "ChairBack <hello@example.com>";
  delete process.env.ADMIN_STEP_UP_ENABLED;
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();
  const { __setSendEmailForTests } = await import("../messaging/email.js");
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: `test_${sent.length}`, status: "sent" };
  });
});

afterAll(async () => {
  const { __setSendEmailForTests } = await import("../messaging/email.js");
  __setSendEmailForTests(undefined);
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  if (savedStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
  else process.env.ADMIN_STEP_UP_ENABLED = savedStepUp;
  __resetEnvCacheForTests();
  await prisma.$disconnect();
});

describe("the gate", () => {
  it("a non-admin still sees nothing at all", async () => {
    const u = await signup("plain");
    expect((await get("/metrics", [u.cookie])).status).toBe(404);
  });

  it("🔴 EVERY part of the portal sits behind it - routes and sub-routers alike", async () => {
    const a = await admin("everywhere");
    const paths = [
      "/metrics",
      "/shops",
      "/analytics?days=30",
      "/preflight",
      "/switches/sms",
      "/affiliate/flags",
      "/partners",
      "/awards",
    ];
    for (const p of paths) {
      const res = await get(p, [a.cookie]);
      expect({ p, status: res.status }).toEqual({ p, status: 403 });
    }
    // Writes too.
    expect((await post("/shops/anything/comp", [a.cookie], { compAccess: true })).status).toBe(403);
  });

  it("🔴 an admin's session alone no longer opens the portal - it asks for the second step", async () => {
    const a = await admin("gate");
    const res = await get("/metrics", [a.cookie]);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "admin_step_up_required" });
    const status = await get("/step-up/status", [a.cookie]);
    expect(status.body).toMatchObject({ required: true, passedUntil: null, totpEnabled: false, emailAvailable: true });
  });
});

describe("the emailed code", () => {
  it("emails a code; the right one opens the portal, and the admin is told", async () => {
    const a = await admin("email");
    const start = await post("/step-up/email/start", [a.cookie]);
    expect(start.status).toBe(200);
    expect(start.body.sentTo).toMatch(/^as•+@test\.local$/);
    expect((await post("/step-up/email/verify", [a.cookie], { code: "000000" })).status).toBe(400);
    const ok = await post("/step-up/email/verify", [a.cookie], { code: lastCodeFor(a.email) });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.passToken).toBe("string");
    expect((await get("/metrics", [a.cookie, pass(ok.body.passToken)])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // the alert is fire-and-forget
    expect(sent.some((m) => m.to === a.email && /admin was opened/.test(m.subject))).toBe(true);
  });

  it("🔴 the session WITHOUT its pass cookie - what a forged copy of it would be - is refused", async () => {
    const a = await admin("forged");
    await passByEmail(a.email, a.cookie);
    expect((await get("/metrics", [a.cookie])).status).toBe(403);
  });

  it("🔴 a pass works only with the session that earned it", async () => {
    const a = await admin("bound");
    const token = await passByEmail(a.email, a.cookie);
    // A session token is {userId, iat, exp} to the SECOND: one minted in the
    // same second is byte-identical (which is why the pass token exists). A
    // genuinely different session needs a different second.
    await new Promise((r) => setTimeout(r, 1100));
    const other = await loginAgain(a.email);
    expect(other).not.toBe(a.cookie);
    expect((await get("/metrics", [other, pass(token)])).status).toBe(403);
    expect((await get("/metrics", [a.cookie, pass(randomToken())])).status).toBe(403);
  });

  it("a code works once", async () => {
    const a = await admin("once");
    await post("/step-up/email/start", [a.cookie]);
    const code = lastCodeFor(a.email);
    expect((await post("/step-up/email/verify", [a.cookie], { code })).status).toBe(200);
    expect((await post("/step-up/email/verify", [a.cookie], { code })).status).toBe(400);
  });

  it("🔴 five wrong tries spend the code - even the right one is refused after", async () => {
    const a = await admin("tries");
    await post("/step-up/email/start", [a.cookie]);
    const code = lastCodeFor(a.email);
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) expect((await post("/step-up/email/verify", [a.cookie], { code: wrong })).status).toBe(400);
    expect((await post("/step-up/email/verify", [a.cookie], { code })).status).toBe(429);
  });

  it("at most five codes an hour", async () => {
    const a = await admin("hourly");
    for (let i = 0; i < 5; i++) expect((await post("/step-up/email/start", [a.cookie])).status).toBe(200);
    expect((await post("/step-up/email/start", [a.cookie])).status).toBe(429);
  });

  it("a pass ends when it expires", async () => {
    const a = await admin("expiry");
    const token = await passByEmail(a.email, a.cookie);
    await runAsOwner((tx) =>
      tx.adminStepUp.updateMany({ where: { userId: a.userId }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );
    expect((await get("/metrics", [a.cookie, pass(token)])).status).toBe(403);
  });
});

describe("the authenticator app", () => {
  it("🔴 setting one up needs a pass first - a stolen session cannot enroll its own", async () => {
    const a = await admin("enroll-blocked");
    expect((await post("/two-step/totp/setup", [a.cookie])).status).toBe(403);
  });

  it("set up after an emailed code; then it opens the portal on another session - once per code", async () => {
    const a = await admin("totp");
    const token = await passByEmail(a.email, a.cookie);
    const setup = await post("/two-step/totp/setup", [a.cookie, pass(token)]);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = setup.body.secret as string;
    const now = totpStep(new Date());
    expect((await post("/two-step/totp/confirm", [a.cookie, pass(token)], { code: "000000" })).status).toBe(400);
    expect(
      (await post("/two-step/totp/confirm", [a.cookie, pass(token)], { code: totpCode(secret, now) })).status,
    ).toBe(200);
    // The secret at rest is sealed, never the plain secret.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: a.userId }, select: { adminTotpSecretEnc: true } });
    expect(row.adminTotpSecretEnc).not.toContain(secret);

    const phone = await loginAgain(a.email);
    expect((await get("/step-up/status", [phone])).body.totpEnabled).toBe(true);
    const next = totpCode(secret, now + 1);
    const ok = await post("/step-up/totp", [phone], { code: next });
    expect(ok.status).toBe(200);
    expect((await get("/metrics", [phone, pass(ok.body.passToken)])).status).toBe(200);
    // The same code again, from anywhere: refused (replay).
    const third = await loginAgain(a.email);
    expect((await post("/step-up/totp", [third], { code: next })).status).toBe(400);
  });

  it("an admin without an app is told so, not just refused", async () => {
    const a = await admin("no-app");
    const res = await post("/step-up/totp", [a.cookie], { code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "not_set_up" });
  });
});

describe("the escape hatch", () => {
  it("ADMIN_STEP_UP_ENABLED=false opens the portal to the admin's session alone", async () => {
    const a = await admin("hatch");
    process.env.ADMIN_STEP_UP_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      expect((await get("/metrics", [a.cookie])).status).toBe(200);
    } finally {
      delete process.env.ADMIN_STEP_UP_ENABLED;
      __resetEnvCacheForTests();
    }
    expect((await get("/metrics", [a.cookie])).status).toBe(403);
  });
});
