import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";
import { createApp } from "../app.js";

/**
 * Public review submission + the barber's moderation inbox. Reviews land PENDING,
 * only APPROVED ones appear on the public page, the notify SMS honors DRY_RUN,
 * and everything is strictly tenant-scoped.
 *
 * 🔴 THE ALERT IS NO LONGER SENT INSIDE THE REQUEST. The review and a durable
 * row per recipient per channel now commit together, and a worker delivers
 * them after that transaction - so a test that asserts on the text has to
 * drain the dispatch first rather than read a captured array the instant the
 * response lands. `settleBackgroundWork` makes that a fact rather than a sleep.
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
  // Armed before anything can dispatch, so no review alert escapes counting.
  armBackgroundWorkTracking();
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

afterEach(async () => {
  // Drain BEFORE clearing: a straggling alert would otherwise land in the next
  // test's array and fail it on a message it never caused (see backgroundWork).
  await settleBackgroundWork();
  sent = [];
});

afterAll(async () => {
  await settleBackgroundWork();
  disarmBackgroundWorkTracking();
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
    await settleBackgroundWork();
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
    // The send is after the commit now, deliberately: a customer leaving a
    // review must not wait on somebody else's SMS.
    await settleBackgroundWork();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+13025550777");
    // 🔴 AND IT SAYS NOTHING THE CUSTOMER TYPED. The submit endpoint is
    // unauthenticated, so "Dana" and the body are free text from a stranger.
    expect(sent[0]!.body).not.toContain("Dana");
    expect(sent[0]!.body).toContain("5-star");

    // Flip DRY_RUN on: the next review saves with no SMS leaving.
    //
    // 🔴 THE FAKE HAS TO COME OUT FOR THIS ONE. The kill switch lives in
    // `getMessageProvider()`, and that factory lets an explicitly injected
    // test provider outrank DRY_RUN on purpose - "so suites can assert
    // real-send behavior". Leaving the fake in and flipping the switch
    // therefore asserts nothing: the send goes to the fake either way. Pulling
    // it puts the real NoopMessageProvider back, which is exactly the shape a
    // dry-run deployment has.
    process.env.DRY_RUN = "true";
    __resetEnvCacheForTests();
    __setMessageProviderForTests(undefined);
    try {
      const r2 = await request(app).post(`/api/page/${slugA}/review`).send({ rating: 3 });
      expect(r2.status).toBe(201);
      await settleBackgroundWork();
      expect(sent).toHaveLength(1); // still just the first

      // And the suppression is RECORDED rather than silent: a terminal row
      // saying "dry_run" is how an operator tells "the switch was on" apart
      // from "this shop had nobody to text", which used to look identical
      // (both produced nothing at all).
      const review = await prisma.review.findFirstOrThrow({
        where: { shop: { slug: slugA } },
        orderBy: { createdAt: "desc" },
      });
      const smsRow = await prisma.reviewNotification.findFirst({
        where: { reviewId: review.id, channel: "sms" },
      });
      expect(smsRow?.status).toBe("skipped");
      expect(smsRow?.lastError).toBe("dry_run");
      // Terminal, so it will never be retried into a real text later.
      expect(smsRow?.attempts).toBe(0);
    } finally {
      process.env.DRY_RUN = "false";
      __resetEnvCacheForTests();
      __setMessageProviderForTests({
        channel: "SMS",
        send: async (input) => {
          sent.push(input);
          return { sid: `SM-fake-${sent.length}`, status: "queued" };
        },
      });
    }
  });

  it("records the promise even for a shop nothing can reach", async () => {
    // 🔴 THE POINT OF THE LEDGER. Before this, a shop with no notify phone
    // took no branch at all: no send, no retry, and nothing on disk saying an
    // alert had been owed. Nine reviews went unannounced and left no trace to
    // find. Now the unreachable case is a row that says WHY.
    const before = await prisma.review.count({ where: { shop: { slug: slugA } } });
    expect(before).toBeGreaterThan(0);

    const rows = await prisma.reviewNotification.findMany({
      where: { shop: { slug: slugA } },
      select: { channel: true, status: true, lastError: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    // Every one of them reached a decision - nothing is left dangling.
    for (const r of rows) {
      expect(["pending", "sent", "skipped", "failed", "abandoned"]).toContain(r.status);
    }
    // And the ones that could not go anywhere say so in a fixed word, never in
    // provider prose and never with a phone number in it.
    for (const r of rows.filter((x) => x.status === "skipped")) {
      expect(r.lastError).toMatch(
        /^(no_destination|no_push_target|channel_off|not_authorized|dry_run|unconfigured|gone)$/,
      );
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

  it("badges the number still awaiting approval, and only this shop's", async () => {
    const listA = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    const pendingA = listA.body.reviews.filter(
      (r: { status: string }) => r.status === "PENDING",
    ).length;
    expect(listA.body.pendingCount).toBe(pendingA);
    expect(listA.body.pendingCount).toBeGreaterThan(0);

    // Shop B has never been reviewed: its badge is zero, not A's number.
    const listB = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieB);
    expect(listB.body.pendingCount).toBe(0);
  });

  it("drops the badge the moment a review is approved", async () => {
    const before = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    const pending = before.body.reviews.find(
      (r: { status: string }) => r.status === "PENDING",
    );
    expect(pending).toBeTruthy();

    await request(app)
      .post(`/api/dashboard/reviews/${pending.id}`)
      .set("Cookie", cookieA)
      .send({ status: "APPROVED" });

    const after = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    expect(after.body.pendingCount).toBe(before.body.pendingCount - 1);
  });

  it("counts the whole backlog, not just the page it returned", async () => {
    // 🔴 THE BUG THIS PINS. `pendingCount` used to be
    // `reviews.filter(...).length` over the first 200 rows, which is right
    // only while a shop has fewer than 200 reviews in total. Past that, older
    // pending ones fall off the end of the page and the badge under-reports
    // the queue it exists to surface - and the header asks for `limit=1`,
    // which under the old code would have badged at most 1 however many were
    // waiting.
    const shop = await prisma.shop.findFirstOrThrow({ where: { slug: slugA } });
    const baseline = await prisma.review.count({
      where: { shopId: shop.id, status: "PENDING" },
    });
    const BULK = `bulk-${randomToken(4)}`;
    await prisma.review.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        shopId: shop.id,
        rating: (i % 5) + 1,
        status: "PENDING",
        authorName: BULK,
      })),
    });

    const badge = await request(app)
      .get("/api/dashboard/reviews?limit=1")
      .set("Cookie", cookieA);

    expect(badge.body.reviews).toHaveLength(1);
    expect(badge.body.pendingCount).toBe(baseline + 205);

    // A full page is still capped at 200 rows while the count stays true.
    const full = await request(app).get("/api/dashboard/reviews").set("Cookie", cookieA);
    expect(full.body.reviews).toHaveLength(200);
    expect(full.body.pendingCount).toBe(baseline + 205);

    await prisma.review.deleteMany({ where: { shopId: shop.id, authorName: BULK } });
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
