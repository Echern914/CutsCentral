import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, createSession, TERMS_VERSION } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The Terms + Privacy clickwrap, from the outside.
 *
 * What must hold: no password signup without the tick (and a refusal creates
 * nothing); a signup with it records the current version in the same write;
 * an account WITHOUT a current agreement (Google/Apple sign-in, everyone from
 * before this) is told to agree, and agreeing records it once; the read-only
 * demo is never asked and can never write the answer.
 */

const app = createApp();
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emails: string[] = [];
function freshEmail(tag: string): string {
  const e = `terms-${tag}-${stamp}@test.local`;
  emails.push(e);
  return e;
}

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.shop.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

const signup = (email: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Terms Tester", smsAttested: true, ...extra });

const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0]!;

describe("password signup", () => {
  it("🔴 without acceptTerms: 400 terms_required, and no account is created", async () => {
    const email = freshEmail("missing");
    const res = await signup(email);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("terms_required");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("acceptTerms: false is a refusal too", async () => {
    const email = freshEmail("false");
    const res = await signup(email, { acceptTerms: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("terms_required");
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("a truthy non-boolean is not an agreement", async () => {
    const email = freshEmail("string");
    const res = await signup(email, { acceptTerms: "true" });
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("with acceptTerms: the account records the current version and when, in the same write", async () => {
    const email = freshEmail("ok");
    const before = Date.now();
    const res = await signup(email, { acceptTerms: true });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { termsAcceptedAt: true, termsAcceptedVersion: true, createdAt: true },
    });
    expect(user.termsAcceptedVersion).toBe(TERMS_VERSION);
    expect(user.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Freshly signed up: the dashboard does not ask again.
    const terms = await request(app).get("/api/auth/terms").set("Cookie", cookieOf(res));
    expect(terms.status).toBe(200);
    expect(terms.body).toMatchObject({ required: false, currentVersion: TERMS_VERSION, acceptedVersion: TERMS_VERSION });
  });
});

describe("the dashboard's Before-you-continue screen", () => {
  /** An account as Google/Apple sign-in (or anyone before this) leaves it: nothing on record. */
  async function unacceptedAccount(tag: string): Promise<{ cookie: string; email: string }> {
    const email = freshEmail(tag);
    const res = await signup(email, { acceptTerms: true });
    expect(res.status).toBe(201);
    await prisma.user.update({ where: { email }, data: { termsAcceptedAt: null, termsAcceptedVersion: null } });
    return { cookie: cookieOf(res), email };
  }

  it("needs a session", async () => {
    expect((await request(app).get("/api/auth/terms")).status).toBe(401);
    expect((await request(app).post("/api/auth/accept-terms").send({ acceptTerms: true })).status).toBe(401);
  });

  it("nothing on record: required", async () => {
    const { cookie } = await unacceptedAccount("none");
    const res = await request(app).get("/api/auth/terms").set("Cookie", cookie);
    expect(res.body).toMatchObject({ required: true, acceptedVersion: null, currentVersion: TERMS_VERSION });
  });

  it("🔴 an OLDER version on record: required again", async () => {
    const { cookie, email } = await unacceptedAccount("old");
    await prisma.user.update({
      where: { email },
      data: { termsAcceptedVersion: "2026-06-12", termsAcceptedAt: new Date("2026-06-12T12:00:00Z") },
    });
    const res = await request(app).get("/api/auth/terms").set("Cookie", cookie);
    expect(res.body).toMatchObject({ required: true, acceptedVersion: "2026-06-12" });
  });

  it("Agree and continue: records the current version, then stops asking", async () => {
    const { cookie, email } = await unacceptedAccount("agree");
    const res = await request(app).post("/api/auth/accept-terms").set("Cookie", cookie).send({ acceptTerms: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: TERMS_VERSION });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.termsAcceptedVersion).toBe(TERMS_VERSION);
    expect(user.termsAcceptedAt).toBeInstanceOf(Date);
    expect((await request(app).get("/api/auth/terms").set("Cookie", cookie)).body.required).toBe(false);
  });

  it("a POST without the tick is not an agreement", async () => {
    const { cookie, email } = await unacceptedAccount("notick");
    for (const body of [{}, { acceptTerms: false }, { acceptTerms: "yes" }]) {
      const res = await request(app).post("/api/auth/accept-terms").set("Cookie", cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("terms_required");
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).termsAcceptedVersion).toBeNull();
  });

  it("agreeing twice keeps the first timestamp", async () => {
    const { cookie, email } = await unacceptedAccount("twice");
    await request(app).post("/api/auth/accept-terms").set("Cookie", cookie).send({ acceptTerms: true });
    const first = (await prisma.user.findUniqueOrThrow({ where: { email } })).termsAcceptedAt!;
    await request(app).post("/api/auth/accept-terms").set("Cookie", cookie).send({ acceptTerms: true });
    const second = (await prisma.user.findUniqueOrThrow({ where: { email } })).termsAcceptedAt!;
    expect(second.getTime()).toBe(first.getTime());
  });

  it("the read-only demo is never asked, and cannot write the answer", async () => {
    const { email } = await unacceptedAccount("demo");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const demo = createSession(user.id, apiEnv().SESSION_SECRET, Math.floor(Date.now() / 1000), 3600, user.tokenVersion, true);
    const read = await request(app).get("/api/auth/terms").set("Authorization", `Bearer ${demo}`);
    expect(read.status).toBe(200);
    expect(read.body.required).toBe(false);
    const write = await request(app)
      .post("/api/auth/accept-terms")
      .set("Authorization", `Bearer ${demo}`)
      .send({ acceptTerms: true });
    expect(write.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).termsAcceptedVersion).toBeNull();
  });
});
