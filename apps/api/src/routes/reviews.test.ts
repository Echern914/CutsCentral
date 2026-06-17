import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { createApp } from "../app.js";

/**
 * Public review submission + the barber's moderation inbox. Reviews land PENDING,
 * only APPROVED ones appear on the public page, the notify SMS honors DRY_RUN,
 * and everything is strictly tenant-scoped.
 */
const app = createApp();
const emailA = `rev-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `rev-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let slugA: string;

let sent: SendMessageInput[] = [];

async function signupAndShop(email: string, name: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Rev", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://rev.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return cookie;
}

// Exercises the notify SEND path, so DRY_RUN off (the route honors DRY_RUN).
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `SM-fake-${sent.length}`, status: "queued" };
    },
  });
  cookieA = await signupAndShop(emailA, "Rev Cuts A");
  cookieB = await signupAndShop(emailB, "Rev Cuts B");
  const me = await request(app).get("/api/shops/me").set("Cookie", cookieA);
  slugA = me.body.slug;
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("public review submission", () => {
  it("404s on an unknown slug", async () => {
    const res = await request(app)
      .post(`/api/page/no-such-shop/review`)
      .send({ rating: 5 });
    expect(res.status).toBe(404);
  });

  it("rejects a missing or out-of-range rating", async () => {
    const noRating = await request(app).post(`/api/page/${slugA}/review`).send({ body: "great" });
    expect(noRating.status).toBe(400);
    const tooHigh = await request(app).post(`/api/page/${slugA}/review`).send({ rating: 6 });
    expect(tooHigh.status).toBe(400);
    const zero = await request(app).post(`/api/page/${slugA}/review`).send({ rating: 0 });
    expect(zero.status).toBe(400);
  });

  it("accepts a review and lands it PENDING (no notify phone)", async () => {
    const res = await request(app)
      .post(`/api/page/${slugA}/review`)
      .send({ rating: 5, body: "Best fade ever", authorName: "Marcus" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(sent).toHaveLength(0); // no notifyPhone -> no SMS

    const list = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    expect(list.status).toBe(200);
    const review = list.body.reviews.find((r: { authorName: string }) => r.authorName === "Marcus");
    expect(review).toBeTruthy();
    expect(review.status).toBe("PENDING");
    expect(review.rating).toBe(5);
    expect(list.body.pendingCount).toBeGreaterThanOrEqual(1);
  });

  it("accepts a rating-only review (no text or name)", async () => {
    const res = await request(app).post(`/api/page/${slugA}/review`).send({ rating: 4 });
    expect(res.status).toBe(201);
  });

  it("does NOT appear on the public page until approved", async () => {
    // Submit, then read the public payload - the pending review must be absent.
    await request(app)
      .post(`/api/page/${slugA}/review`)
      .send({ rating: 1, body: "secretly pending", authorName: "Hidden" });
    const pub = await request(app).get(`/api/page/${slugA}`);
    expect(pub.status).toBe(200);
    expect(
      pub.body.reviews.some((r: { authorName: string }) => r.authorName === "Hidden"),
    ).toBe(false);
  });

  it("texts the barber when notifyPhone is set (honors DRY_RUN)", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ notifyPhone: "(302) 555-0777" });

    const res = await request(app)
      .post(`/api/page/${slugA}/review`)
      .send({ rating: 5, authorName: "Dana" });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+13025550777");

    // Flip DRY_RUN on: the next review saves with no SMS leaving.
    process.env.DRY_RUN = "true";
    __resetEnvCacheForTests();
    try {
      const r2 = await request(app).post(`/api/page/${slugA}/review`).send({ rating: 3 });
      expect(r2.status).toBe(201);
      expect(sent).toHaveLength(1); // still just the first
    } finally {
      process.env.DRY_RUN = "false";
      __resetEnvCacheForTests();
    }
  });
});

describe("dashboard review moderation", () => {
  it("approves a review and it then shows publicly with an average", async () => {
    const list = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    const pending = list.body.reviews.find((r: { status: string }) => r.status === "PENDING");
    expect(pending).toBeTruthy();

    const approve = await request(app)
      .post(`/api/dashboard/reviews/${pending.id}`)
      .set("Cookie", cookieA)
      .send({ status: "APPROVED" });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("APPROVED");

    const pub = await request(app).get(`/api/page/${slugA}`);
    expect(pub.body.reviews.some((r: { id: string }) => r.id === pending.id)).toBe(true);
    expect(pub.body.reviewSummary.count).toBeGreaterThanOrEqual(1);
    expect(pub.body.reviewSummary.avgRating).toBeGreaterThan(0);
  });

  it("hides an approved review and it drops off the public page", async () => {
    const pub1 = await request(app).get(`/api/page/${slugA}`);
    const liveId = pub1.body.reviews[0]?.id as string;
    expect(liveId).toBeTruthy();

    const hide = await request(app)
      .post(`/api/dashboard/reviews/${liveId}`)
      .set("Cookie", cookieA)
      .send({ status: "HIDDEN" });
    expect(hide.status).toBe(200);

    const pub2 = await request(app).get(`/api/page/${slugA}`);
    expect(pub2.body.reviews.some((r: { id: string }) => r.id === liveId)).toBe(false);
  });

  it("rejects an unknown status", async () => {
    const list = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    const id = list.body.reviews[0].id as string;
    const res = await request(app)
      .post(`/api/dashboard/reviews/${id}`)
      .set("Cookie", cookieA)
      .send({ status: "BOGUS" });
    expect(res.status).toBe(400);
  });

  it("another shop cannot see or moderate my reviews", async () => {
    const listA = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    const id = listA.body.reviews[0].id as string;

    const listB = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieB);
    expect(listB.body.reviews).toHaveLength(0);

    const res = await request(app)
      .post(`/api/dashboard/reviews/${id}`)
      .set("Cookie", cookieB)
      .send({ status: "APPROVED" });
    expect(res.status).toBe(404);
  });
});
