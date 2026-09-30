import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { WHATS_NEW } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * "What's new" in the dashboard bell: one marker per person - the newest
 * changelog entry they have seen. /me hands it (and when the account began)
 * to the bell; opening the bell moves it forward. Only real entry ids, and
 * never backwards: a tab left open on an older deploy cannot un-see newer
 * entries.
 */

const app = createApp();
const email = `whatsnew-${Date.now()}@test.local`;
let cookie: string;

beforeAll(async () => {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "News Reader", smsAttested: true });
  expect(res.status).toBe(201);
  cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

const me = async () => (await request(app).get("/api/auth/me").set("Cookie", cookie)).body;
const seen = (id: string) => request(app).post("/api/auth/whats-new-seen").set("Cookie", cookie).send({ id });

describe("what's new, per person", () => {
  it("a new account has seen nothing yet, and says when it began", async () => {
    const body = await me();
    expect(body.whatsNew.seenId).toBeNull();
    expect(Number.isNaN(Date.parse(body.whatsNew.accountCreatedAt))).toBe(false);
    // Only the marker is exposed, not the raw columns.
    expect(body.whatsNewSeenId).toBeUndefined();
    expect(body.createdAt).toBeUndefined();
  });

  it("opening the bell stores the newest entry", async () => {
    const res = await seen(WHATS_NEW[0]!.id);
    expect(res.status).toBe(200);
    expect((await me()).whatsNew.seenId).toBe(WHATS_NEW[0]!.id);
  });

  it("🔴 never moves backwards - an older tab cannot un-see newer entries", async () => {
    const older = WHATS_NEW.at(-1)!;
    expect((await seen(older.id)).status).toBe(200);
    expect((await me()).whatsNew.seenId).toBe(WHATS_NEW[0]!.id);
  });

  it("refuses an id the changelog does not contain", async () => {
    expect((await seen("2099-01-01-made-up")).status).toBe(400);
    expect((await request(app).post("/api/auth/whats-new-seen").set("Cookie", cookie).send({})).status).toBe(400);
    expect((await me()).whatsNew.seenId).toBe(WHATS_NEW[0]!.id);
  });

  it("needs a signed-in person", async () => {
    expect((await request(app).post("/api/auth/whats-new-seen").send({ id: WHATS_NEW[0]!.id })).status).toBe(401);
  });
});
