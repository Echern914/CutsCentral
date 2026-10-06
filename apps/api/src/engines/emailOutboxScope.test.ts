import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { runEmailOutbox } from "./emailOutbox.js";

/**
 * A SCOPED TEST DRAIN REACHES ITS OWN ROW, WHATEVER IS LEFT IN THE QUEUE.
 *
 * EmailIntent has no foreign key to Shop, so a PENDING intent a suite leaves
 * behind outlives its shop. An unscoped drain claims the OLDEST due rows first,
 * 25 at a time - enough leftovers and a test's own cancellation email is never
 * reached ("expected [] to have a length of 1"). Test drains pass `shopId`;
 * production never does (scheduler.emailOutboxScope.test.ts).
 */

const ghostShop = `ghost-${randomToken(8)}`;
const myShop = `mine-${randomToken(8)}`;

afterAll(async () => {
  await prisma.emailIntent.deleteMany({ where: { shopId: { in: [ghostShop, myShop] } } });
});

describe("the email outbox's test-only shop scope", () => {
  it("🔴 30 older leftovers of a deleted shop do not crowd out this shop's row", async () => {
    // Older than anything else due, so an unscoped pass would take them first.
    await prisma.emailIntent.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        kind: "appointment_canceled",
        idempotencyKey: `${ghostShop}:${i}`,
        shopId: ghostShop,
        status: "PENDING",
        nextAttemptAt: new Date(0),
        createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)),
      })),
    });
    await prisma.emailIntent.create({
      data: {
        kind: "appointment_canceled",
        idempotencyKey: `${myShop}:own`,
        shopId: myShop,
        status: "PENDING",
        nextAttemptAt: new Date(0),
      },
    });

    const res = await runEmailOutbox({ shopId: myShop, batch: 25 });

    expect(res.claimed).toBe(1);
    const ghostsTouched = await prisma.emailIntent.count({
      where: { shopId: ghostShop, claimToken: { not: null } },
    });
    expect(ghostsTouched).toBe(0);
  });
});
