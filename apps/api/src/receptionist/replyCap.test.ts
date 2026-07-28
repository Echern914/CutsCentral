import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  RECEPTIONIST_REPLY_LIMITS,
  receptionistReplyCapReason,
} from "./replyCap.js";

/**
 * Receptionist reply abuse caps: per-client and per-shop daily counting on the
 * Nudge ledger (kind="receptionist_reply", ANY status, UTC day window).
 */

const NOW = new Date("2026-06-15T12:00:00Z");

let userId: string;
let shopId: string;
let clientA: string;
let clientB: string;

async function seedReplies(
  clientId: string,
  count: number,
  over: Record<string, unknown> = {},
) {
  await prisma.nudge.createMany({
    data: Array.from({ length: count }, () => ({
      shopId,
      clientId,
      channel: "SMS" as const,
      status: "SENT" as const,
      kind: "receptionist_reply",
      createdAt: NOW,
      ...over,
    })),
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rcap-${randomToken(6)}@test.local`, passwordHash: "x", name: "R" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Reply Cap Shop",
      bookingUrl: "https://rcap.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  const [a, b] = await Promise.all(
    ["a", "b"].map((k) =>
      prisma.client.create({
        data: {
          shopId,
          acuityClientKey: `rcap-${k}-${randomToken(6)}`,
          magicToken: randomToken(),
          firstName: k.toUpperCase(),
          phone: k === "a" ? "+13025550171" : "+13025550172",
        },
      }),
    ),
  );
  clientA = a!.id;
  clientB = b!.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("receptionistReplyCapReason", () => {
  it("is null under both caps", async () => {
    expect(await receptionistReplyCapReason(shopId, clientA, NOW)).toBeNull();
  });

  it("trips the per-client cap at exactly the limit; FAILED attempts count; yesterday doesn't", async () => {
    const limit = RECEPTIONIST_REPLY_LIMITS.perClientPerDay;

    // Yesterday's replies are free (UTC day window).
    await seedReplies(clientA, 5, { createdAt: new Date("2026-06-14T23:59:59Z") });
    // limit-1 today (mixing in a FAILED - attempts count) -> still under.
    await seedReplies(clientA, limit - 2);
    await seedReplies(clientA, 1, { status: "FAILED" });
    expect(await receptionistReplyCapReason(shopId, clientA, NOW)).toBeNull();

    // One more crosses the threshold.
    await seedReplies(clientA, 1);
    expect(await receptionistReplyCapReason(shopId, clientA, NOW)).toBe(
      "client_daily_cap",
    );

    // A different client at the same shop is unaffected.
    expect(await receptionistReplyCapReason(shopId, clientB, NOW)).toBeNull();
  });

  it("trips the per-shop cap across clients", async () => {
    // clientA already holds perClientPerDay rows today; top the SHOP total up
    // to the shop limit using clientB but stay under B's own client cap by
    // spreading... perShopPerDay >> perClientPerDay, so seed extra clients.
    const already = await prisma.nudge.count({
      where: {
        shopId,
        kind: "receptionist_reply",
        createdAt: { gte: new Date("2026-06-15T00:00:00Z") },
      },
    });
    const needed = RECEPTIONIST_REPLY_LIMITS.perShopPerDay - already;
    // Spread across throwaway clients so no single one trips its client cap
    // before the shop cap is reached.
    const per = RECEPTIONIST_REPLY_LIMITS.perClientPerDay - 1;
    let remaining = needed;
    while (remaining > 0) {
      const c = await prisma.client.create({
        data: {
          shopId,
          acuityClientKey: `rcap-x-${randomToken(8)}`,
          magicToken: randomToken(),
          firstName: "X",
        },
      });
      const n = Math.min(per, remaining);
      await seedReplies(c.id, n);
      remaining -= n;
    }

    expect(await receptionistReplyCapReason(shopId, clientB, NOW)).toBe(
      "shop_daily_cap",
    );
  });
});

/**
 * The monthly ceiling. The daily caps reset at every UTC midnight, so without
 * this a patient attacker could park at the daily limit indefinitely. These
 * tests use their OWN shop so the daily-cap suite above can't interfere.
 */
describe("receptionistReplyCapReason - monthly ceiling", () => {
  let monthShopId: string;
  let monthClientId: string;

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Monthly Cap Shop",
        bookingUrl: "https://mcap.test",
        webhookSecret: randomToken(),
      },
    });
    monthShopId = shop.id;
    const c = await prisma.client.create({
      data: {
        shopId: monthShopId,
        acuityClientKey: `mcap-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "M",
      },
    });
    monthClientId = c.id;
  });

  it("trips at the monthly limit from EARLIER days that are under today's daily cap", async () => {
    const monthly = RECEPTIONIST_REPLY_LIMITS.perShopPerMonth;
    // Spread the whole month's volume across earlier days of the SAME UTC
    // month, so neither daily cap is in play today - only the monthly one.
    // Each earlier day gets its own throwaway client too, so the per-client
    // day cap is never the reason.
    // Seed ONLY days 1-14, i.e. strictly BEFORE NOW (the 15th). Two reasons:
    // the daily windows are `createdAt >= dayStart` with no upper bound, so
    // future-dated rows would count toward "today" and trip the daily cap
    // first; and past-dated volume is what the monthly ceiling is actually
    // about. 14 days x 150 = 2100 >= the 2000 monthly limit.
    const perDay = Math.ceil(monthly / 14);
    let remaining = monthly;
    let day = 1;
    while (remaining > 0 && day <= 14) {
      const c = await prisma.client.create({
        data: {
          shopId: monthShopId,
          acuityClientKey: `mcap-d-${randomToken(8)}`,
          magicToken: randomToken(),
          firstName: "D",
        },
      });
      const n = Math.min(perDay, remaining);
      const stamp = new Date(
        `2026-06-${String(day).padStart(2, "0")}T10:00:00Z`,
      );
      await prisma.nudge.createMany({
        data: Array.from({ length: n }, () => ({
          shopId: monthShopId,
          clientId: c.id,
          channel: "SMS" as const,
          status: "SENT" as const,
          kind: "receptionist_reply",
          createdAt: stamp,
        })),
      });
      remaining -= n;
      day += 1;
    }

    // Today is clean (0 replies today), so only the monthly ceiling can fire.
    expect(await receptionistReplyCapReason(monthShopId, monthClientId, NOW)).toBe(
      "shop_monthly_cap",
    );
  });

  it("does not count LAST month's replies", async () => {
    const freshShop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Last Month Shop",
        bookingUrl: "https://lmcap.test",
        webhookSecret: randomToken(),
      },
    });
    const c = await prisma.client.create({
      data: {
        shopId: freshShop.id,
        acuityClientKey: `lmcap-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "L",
      },
    });
    // A full month's worth, but in MAY - June's window must ignore it.
    await prisma.nudge.createMany({
      data: Array.from(
        { length: RECEPTIONIST_REPLY_LIMITS.perShopPerMonth },
        () => ({
          shopId: freshShop.id,
          clientId: c.id,
          channel: "SMS" as const,
          status: "SENT" as const,
          kind: "receptionist_reply",
          createdAt: new Date("2026-05-20T10:00:00Z"),
        }),
      ),
    });
    expect(await receptionistReplyCapReason(freshShop.id, c.id, NOW)).toBeNull();
  });
});
