import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { SquareBooking, SquareCustomer } from "../square/types.js";

/**
 * Contracts pinned here:
 * 1. The SAFE no-op the scheduler depends on: with no Square connections the
 *    sweep queries cleanly, ingests nothing, never throws.
 * 2. It walks the WHOLE window across pages, not just the first 100 - the
 *    exact bug acuity/walk.ts was extracted to kill.
 * 3. It re-reads idempotently, and it covers the FUTURE. Square bookings block
 *    native slots and drive the ~24h reminder, so a future booking the sweep
 *    can't see is a double-booking waiting to happen.
 * 4. 🔴 A connection that never received its whole book gets it from the
 *    sweep - history included - which is how the shops whose imports all
 *    failed (Square refuses a range over 31 days) finally receive theirs.
 * 5. What happened is written on the connection: a refusal is recorded, and
 *    the next success clears it.
 *
 * The fake refuses a range over 31 days exactly as Square does, so a walk
 * that stops slicing fails here the way production did.
 */

const NOW = new Date("2026-08-05T12:00:00Z");

function booking(i: number, startAt: Date): SquareBooking {
  return {
    id: `sq${i}`,
    status: "ACCEPTED",
    start_at: startAt.toISOString(),
    location_id: "loc1",
    customer_id: `cust${i}`,
    appointment_segments: [{ duration_minutes: 30 }],
  } as unknown as SquareBooking;
}

// 250 bookings, one per hour STARTING NOW - i.e. all in the future. Forces 3
// pages against a 100-per-page server, and fails outright if the window ends
// at "now" the way the old backfill did.
const UPCOMING: SquareBooking[] = Array.from({ length: 250 }, (_, i) =>
  booking(i + 1, new Date(NOW.getTime() + i * 3600_000)),
);
// History far outside the sweep's week of lookback: only a whole-book import
// reaches it.
const HISTORY: SquareBooking = booking(9001, new Date("2019-05-14T15:00:00Z"));
const WINDOW: SquareBooking[] = [...UPCOMING, HISTORY];

/** When set, every Square call for a shop fails like this (a refused token). */
let failAll: { status: number; code: string } | null = null;

vi.mock("../square/client.js", () => ({
  getSquareClientForShop: vi.fn(async () => ({
    getBooking: async (id: string) => WINDOW.find((b) => b.id === id)!,
    getCustomer: async (id: string): Promise<SquareCustomer> =>
      ({
        id,
        given_name: `C${id}`,
        phone_number: `+1302555${id.replace(/\D/g, "").padStart(4, "0").slice(-4)}`,
      }) as SquareCustomer,
    listBookings: async (p: {
      startAtMin?: string;
      startAtMax?: string;
      limit?: number;
      cursor?: string | null;
    }) => {
      if (failAll) {
        throw Object.assign(new Error(`Square ${failAll.status} (${failAll.code})`), failAll);
      }
      const min = p.startAtMin ? Date.parse(p.startAtMin) : 0;
      const max = p.startAtMax ? Date.parse(p.startAtMax) : Number.POSITIVE_INFINITY;
      // Square: "the start-time range cannot be longer than 31 days".
      if (max - min > 31 * 24 * 3600_000) {
        throw Object.assign(new Error("Square 400 on /v2/bookings (BAD_REQUEST)"), {
          status: 400,
          code: "BAD_REQUEST",
        });
      }
      const inWindow = WINDOW.filter((b) => {
        const t = Date.parse(b.start_at);
        return t >= min && t <= max;
      });
      const offset = p.cursor ? Number(p.cursor) : 0;
      const slice = inWindow.slice(offset, offset + (p.limit ?? 100));
      const nextOffset = offset + slice.length;
      return {
        bookings: slice,
        cursor: nextOffset < inWindow.length ? String(nextOffset) : null,
      };
    },
  })),
  NotConnectedError: class extends Error {},
  SquareError: class extends Error {},
  squareEnabled: () => true,
}));

const { runSquareResync } = await import("./squareResync.js");

let userId: string | null = null;
let shopId: string | null = null;
const extraShops: string[] = [];

afterAll(async () => {
  const shops = [shopId, ...extraShops].filter((s): s is string => s !== null);
  if (shops.length) await prisma.shop.deleteMany({ where: { id: { in: shops } } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

async function connectedShop(name: string, backfilledAt: Date | null): Promise<string> {
  const shop = await prisma.shop.create({
    data: { ownerId: userId!, name, bookingMode: "square", webhookSecret: randomToken() },
  });
  // The client module is fully mocked, so the token fields are never read.
  await prisma.squareConnection.create({
    data: {
      shopId: shop.id,
      squareMerchantId: `m-${randomToken(6)}`,
      squareLocationId: "loc1",
      accessToken: "unused",
      refreshToken: "unused",
      tokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000),
      backfilledAt,
    },
  });
  return shop.id;
}

describe("runSquareResync", () => {
  it("is a clean no-op when no shops have a Square connection", async () => {
    const existing = await prisma.squareConnection.count();
    if (existing === 0) {
      await expect(runSquareResync(NOW)).resolves.toEqual({
        shops: 0,
        ingested: 0,
        failedShops: 0,
        backfilled: 0,
      });
    } else {
      await expect(runSquareResync(NOW)).resolves.toMatchObject({
        ingested: expect.any(Number),
      });
    }
  });

  describe("page walk over a future-spanning window", () => {
    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `sqrs-${randomToken(6)}@test.local`,
          passwordHash: "x",
          name: "SQRS",
        },
      });
      userId = user.id;
      // Already has its whole book, so the sweep reads only its window.
      shopId = await connectedShop("Square Resync Shop", new Date(NOW.getTime() - 3600_000));
    });

    // 250 bookings x a runWithShop tx each - integration-slow, like backfill.
    const TIMEOUT = 180_000;

    it(
      "ingests the WHOLE window across pages, including future bookings",
      async () => {
        const res = await runSquareResync(NOW);
        expect(res.failedShops).toBe(0);
        expect(res.ingested).toBe(250);
        expect(await prisma.visit.count({ where: { shopId: shopId! } })).toBe(250);
        // Every one of these is in the future - the old backfill window
        // (… -> now) would have found exactly zero of them.
        const future = await prisma.visit.count({
          where: { shopId: shopId!, scheduledAt: { gt: NOW } },
        });
        expect(future).toBeGreaterThan(240);
      },
      TIMEOUT,
    );

    it(
      "is idempotent - a second sweep re-reads but creates no duplicates",
      async () => {
        await runSquareResync(NOW);
        expect(await prisma.visit.count({ where: { shopId: shopId! } })).toBe(250);
      },
      TIMEOUT,
    );

    it("namespaces visits as square:{bookingId}", async () => {
      const v = await prisma.visit.findFirst({
        where: { shopId: shopId!, acuityAppointmentId: { startsWith: "square:" } },
        select: { acuityAppointmentId: true },
      });
      expect(v?.acuityAppointmentId).toMatch(/^square:sq\d+$/);
    });

    it("skips a seller who revoked us, instead of 401ing every 30 minutes", async () => {
      await prisma.squareConnection.update({
        where: { shopId: shopId! },
        data: { revokedAt: new Date() },
      });
      const res = await runSquareResync(NOW);
      expect(res.shops).toBe(0);
      expect(res.ingested).toBe(0);
      // Restore so ordering can't leak into a later run.
      await prisma.squareConnection.update({
        where: { shopId: shopId! },
        data: { revokedAt: null },
      });
    });

    it("stamps the connection with the sweep it just finished", async () => {
      const conn = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: shopId! } });
      expect(conn.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
      expect(conn.lastSyncError).toBeNull();
    });
  });

  describe("🔴 a connection that never received its whole book", () => {
    let fresh: string;
    beforeAll(async () => {
      // Only this shop is swept below: the one above is done with.
      await prisma.squareConnection.update({ where: { shopId: shopId! }, data: { revokedAt: new Date() } });
      fresh = await connectedShop("Square Never Imported", null);
      extraShops.push(fresh);
    });

    it(
      "gets it from the sweep - years of history included - and is stamped as imported",
      async () => {
        const res = await runSquareResync(NOW);
        expect(res).toMatchObject({ shops: 1, backfilled: 1, failedShops: 0 });
        expect(await prisma.visit.count({ where: { shopId: fresh } })).toBe(251);
        // Six years before the sweep's week of lookback: only a whole-book
        // import reaches it.
        const history = await prisma.visit.findUnique({
          where: { shopId_acuityAppointmentId: { shopId: fresh, acuityAppointmentId: "square:sq9001" } },
        });
        expect(history?.scheduledAt.toISOString()).toBe("2019-05-14T15:00:00.000Z");
        const conn = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: fresh } });
        expect(conn.backfilledAt).not.toBeNull();
        expect(conn.lastSyncedAt).not.toBeNull();
        expect(conn.lastSyncError).toBeNull();
      },
      180_000,
    );

    it(
      "and from then on the sweep reads only its window",
      async () => {
        const res = await runSquareResync(NOW);
        expect(res).toMatchObject({ shops: 1, backfilled: 0, failedShops: 0, ingested: 250 });
      },
      180_000,
    );

    it(
      "a sweep Square refuses is recorded on the connection, and the next success clears it",
      async () => {
        failAll = { status: 401, code: "UNAUTHORIZED" };
        try {
          const res = await runSquareResync(NOW);
          expect(res.failedShops).toBe(1);
        } finally {
          failAll = null;
        }
        const refused = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: fresh } });
        expect(refused.lastSyncError).toBe("UNAUTHORIZED");
        // A failed sweep never un-imports the book.
        expect(refused.backfilledAt).not.toBeNull();

        await runSquareResync(NOW);
        const healed = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: fresh } });
        expect(healed.lastSyncError).toBeNull();
      },
      180_000,
    );

    it(
      "an import Square refuses stays owed: the next sweep tries the whole book again",
      async () => {
        await prisma.squareConnection.update({ where: { shopId: fresh }, data: { backfilledAt: null } });
        failAll = { status: 503, code: "SERVICE_UNAVAILABLE" };
        try {
          expect(await runSquareResync(NOW)).toMatchObject({ failedShops: 1 });
        } finally {
          failAll = null;
        }
        const owed = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: fresh } });
        expect(owed.backfilledAt).toBeNull();
        expect(owed.lastSyncError).toBe("SERVICE_UNAVAILABLE");

        expect(await runSquareResync(NOW)).toMatchObject({ backfilled: 1, failedShops: 0 });
        const done = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: fresh } });
        expect(done.backfilledAt).not.toBeNull();
        expect(done.lastSyncError).toBeNull();
      },
      180_000,
    );
  });
});
