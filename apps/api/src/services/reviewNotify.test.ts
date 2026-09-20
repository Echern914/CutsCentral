import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  activeReviewRecipients,
  enqueueReviewNotifications,
  reviewAlertCopy,
} from "./reviewNotify.js";

/**
 * WHO IS PROMISED A REVIEW ALERT, AND HOW THAT PROMISE IS WRITTEN.
 *
 * 🔴 THIS FILE EXISTS BECAUSE NINE REVIEWS WERE SILENT. The route created the
 * Review and then texted `Shop.notifyPhone` inline - one channel, one number,
 * no row, no retry. A shop with no notify phone got nothing at all and left no
 * evidence that anything had been owed, which is why it took a customer
 * complaint rather than a log line to find.
 *
 * The delivery side is pinned separately (engines/reviewNotifyOutbox.test.ts).
 * This file is only about what is committed WITH the review.
 */
const app = createApp();

interface Shop {
  shopId: string;
  ownerId: string;
  slug: string;
  cookie: string;
}

const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "") + "z";
const emails: string[] = [];

async function makeShop(tag: string): Promise<Shop> {
  const email = `revnotify-${tag}-${suffix}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: `Owner ${tag}`, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Review Shop ${tag}`, bookingUrl: "https://rv.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const row = await prisma.shop.findUniqueOrThrow({
    where: { id: shop.body.id },
    select: { ownerId: true, slug: true },
  });
  expect(row.slug).toBeTruthy();
  return { shopId: shop.body.id, ownerId: row.ownerId, slug: row.slug!, cookie };
}

/** A second person with a seat in someone else's shop. */
async function seat(shopId: string, tag: string, role: "MANAGER" | "BARBER") {
  const email = `revnotify-seat-${tag}-${suffix}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({
    data: { email, name: `Seat ${tag}`, passwordHash: null },
  });
  const member = await prisma.shopMember.create({
    data: { shopId, userId: user.id, role },
  });
  return { userId: user.id, memberId: member.id };
}

/** Enqueue against a real review, through a real transaction. */
async function enqueueFor(shopId: string, rating = 5): Promise<string> {
  const review = await prisma.review.create({
    data: { shopId, rating, body: "hidden text", authorName: "Hidden Name" },
  });
  await prisma.$transaction((tx) =>
    enqueueReviewNotifications(tx, { shopId, reviewId: review.id }),
  );
  return review.id;
}

const rowsFor = (reviewId: string) =>
  prisma.reviewNotification.findMany({
    where: { reviewId },
    orderBy: [{ userId: "asc" }, { channel: "asc" }],
    select: { userId: true, channel: true, status: true, shopId: true },
  });

let A: Shop;
let B: Shop;

beforeAll(async () => {
  A = await makeShop("a");
  B = await makeShop("b");
});

beforeEach(async () => {
  await prisma.reviewNotification.deleteMany({
    where: { shopId: { in: [A.shopId, B.shopId] } },
  });
  await prisma.review.deleteMany({ where: { shopId: { in: [A.shopId, B.shopId] } } });
  await prisma.barberNotifyPref.deleteMany({
    where: { shopId: { in: [A.shopId, B.shopId] } },
  });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) continue;
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("who gets told", () => {
  it("is exactly the people who could open the page the alert links to", async () => {
    const manager = await seat(A.shopId, "mgr", "MANAGER");
    const barber = await seat(A.shopId, "brb", "BARBER");

    const recipients = await activeReviewRecipients(prisma, A.shopId);

    expect(recipients).toContain(A.ownerId);
    expect(recipients).toContain(manager.userId);
    // 🔴 A BARBER SEAT IS NOT A RECIPIENT, because /api/dashboard/reviews is
    // requireManager. Alerting somebody about a queue they get a 403 from is
    // a notification that can only be acted on by asking somebody else.
    expect(recipients).not.toContain(barber.userId);

    await prisma.shopMember.deleteMany({
      where: { id: { in: [manager.memberId, barber.memberId] } },
    });
  });

  it("includes an owner who holds no seat at all", async () => {
    // 🔴 OWNERSHIP COMES FROM Shop.ownerId AND NOWHERE ELSE (middleware/
    // auth.ts says the same). A new shop is given an OWNER seat for the Team
    // roster's sake, but that row is a convenience, not the source of truth -
    // and the team-members migration backfilled it, so a shop that predates
    // it may not have one. Reading membership alone would leave the one person
    // who definitely wants this out of the list.
    const owned = await prisma.shopMember.findFirst({
      where: { shopId: A.shopId, userId: A.ownerId },
    });
    expect(owned).not.toBeNull();
    await prisma.shopMember.delete({ where: { id: owned!.id } });

    expect(await activeReviewRecipients(prisma, A.shopId)).toEqual([A.ownerId]);

    await prisma.shopMember.create({
      data: { shopId: A.shopId, userId: A.ownerId, role: "OWNER" },
    });
  });

  it("does not tell an owner twice for holding their own seat", async () => {
    // They are the ownerId AND an OWNER seat; a naive concat would produce two
    // of every row, and only the unique key would notice.
    const recipients = await activeReviewRecipients(prisma, A.shopId);
    expect(recipients.filter((id) => id === A.ownerId)).toHaveLength(1);
  });

  it("drops a manager the moment their seat is removed", async () => {
    const manager = await seat(A.shopId, "gone", "MANAGER");
    expect(await activeReviewRecipients(prisma, A.shopId)).toContain(manager.userId);

    await prisma.shopMember.delete({ where: { id: manager.memberId } });

    expect(await activeReviewRecipients(prisma, A.shopId)).not.toContain(manager.userId);
  });
});

describe("tenant isolation", () => {
  it("never enqueues another shop's owner", async () => {
    const reviewId = await enqueueFor(A.shopId);
    const rows = await rowsFor(reviewId);

    expect(rows.length).toBeGreaterThan(0);
    // Every row belongs to shop A, and to a person who belongs to shop A.
    expect(new Set(rows.map((r) => r.shopId))).toEqual(new Set([A.shopId]));
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([A.ownerId]));
    expect(rows.map((r) => r.userId)).not.toContain(B.ownerId);
  });

  it("keeps two shops' queues separate when both are reviewed", async () => {
    const a = await enqueueFor(A.shopId);
    const b = await enqueueFor(B.shopId);

    expect((await rowsFor(a)).map((r) => r.userId)).toEqual(
      Array((await rowsFor(a)).length).fill(A.ownerId),
    );
    expect((await rowsFor(b)).map((r) => r.userId)).toEqual(
      Array((await rowsFor(b)).length).fill(B.ownerId),
    );
  });
});

describe("duplicate enqueue", () => {
  it("collapses a second enqueue of the same review onto the same rows", async () => {
    const reviewId = await enqueueFor(A.shopId);
    const first = await rowsFor(reviewId);
    expect(first.length).toBeGreaterThan(0);

    // A retried request, a replayed worker, a second process - all of it ends
    // up here, and none of it may double the queue.
    const added = await prisma.$transaction((tx) =>
      enqueueReviewNotifications(tx, { shopId: A.shopId, reviewId }),
    );

    expect(added).toBe(0);
    expect(await rowsFor(reviewId)).toHaveLength(first.length);
  });

  it("is the DATABASE refusing it, not the code remembering", async () => {
    // 🔴 ASSERT THE CONSTRAINT DIRECTLY. `skipDuplicates` silently swallowing
    // a clash and a unique index actually existing are different facts, and
    // only the second one survives a code path nobody thought of. A missing
    // index makes this insert succeed.
    const reviewId = await enqueueFor(A.shopId);
    const existing = (await rowsFor(reviewId))[0]!;

    await expect(
      prisma.reviewNotification.create({
        data: {
          shopId: A.shopId,
          reviewId,
          userId: existing.userId,
          channel: existing.channel,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("channels", () => {
  it("gives a push-only shop exactly one row", async () => {
    await prisma.barberNotifyPref.create({
      data: {
        shopId: A.shopId,
        userId: A.ownerId,
        pushEnabled: true,
        smsEnabled: false,
        emailEnabled: false,
      },
    });

    const reviewId = await enqueueFor(A.shopId);

    expect((await rowsFor(reviewId)).map((r) => r.channel)).toEqual(["push"]);
  });

  it("defaults a shop that never opened settings to push and SMS", async () => {
    // NOTIFY_DEFAULTS: push on (free), booking SMS on (what a shop with a
    // notifyPhone already got), email off. An absent prefs row must behave
    // exactly like those defaults rather than like silence.
    const reviewId = await enqueueFor(A.shopId);

    expect((await rowsFor(reviewId)).map((r) => r.channel)).toEqual(["push", "sms"]);
  });

  it("enqueues nothing for a recipient with every channel off", async () => {
    await prisma.barberNotifyPref.create({
      data: {
        shopId: A.shopId,
        userId: A.ownerId,
        pushEnabled: false,
        smsEnabled: false,
        emailEnabled: false,
      },
    });

    const reviewId = await enqueueFor(A.shopId);

    // Zero rows is a legitimate answer, not a failure - and the review is
    // still in the badge, which is the delivery that cannot be switched off.
    expect(await rowsFor(reviewId)).toHaveLength(0);
    expect(
      await prisma.review.count({ where: { id: reviewId, status: "PENDING" } }),
    ).toBe(1);
  });

  it("enqueues an email row only when email is switched on", async () => {
    await prisma.barberNotifyPref.create({
      data: {
        shopId: A.shopId,
        userId: A.ownerId,
        pushEnabled: false,
        smsEnabled: false,
        emailEnabled: true,
      },
    });

    const reviewId = await enqueueFor(A.shopId);

    expect((await rowsFor(reviewId)).map((r) => r.channel)).toEqual(["email"]);
  });
});

describe("the review and the promise commit together", () => {
  it("writes both, through the public route", async () => {
    const res = await request(app)
      .post(`/api/page/${A.slug}/review`)
      .send({ rating: 4, body: "Great fade", authorName: "Sam" });
    expect(res.status).toBe(201);

    const review = await prisma.review.findFirstOrThrow({
      where: { shopId: A.shopId },
      orderBy: { createdAt: "desc" },
    });
    expect(review.status).toBe("PENDING");
    // The promise exists on disk the instant the review does. Whether it was
    // DELIVERED is the worker's problem and a separate file's assertions.
    expect((await rowsFor(review.id)).length).toBeGreaterThan(0);
  });
});

describe("what an alert may say", () => {
  const copy = reviewAlertCopy({
    shopName: "Fade Factory",
    rating: 5,
    appBaseUrl: "https://app.test",
  });

  it("carries the rating and the shop, and nothing the customer typed", () => {
    // 🔴 THE REVIEW BODY AND THE AUTHOR NAME ARE UNAUTHENTICATED FREE TEXT.
    // Anybody who can load the public page can put anything in them. Relaying
    // that into an SMS, a push payload and an email would hand a stranger a
    // way to send whatever they like to a barber's phone under the shop's own
    // name, before a single human has looked at it.
    expect(copy.body).toContain("Fade Factory");
    expect(copy.body).toContain("5-star");
    expect(`${copy.title} ${copy.body}`).not.toMatch(/Great fade|Sam|hidden/i);
  });

  it("links straight to the moderation queue", () => {
    expect(copy.url).toBe("https://app.test/dashboard/reviews");
  });
});
