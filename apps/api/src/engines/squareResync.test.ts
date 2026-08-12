import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { SquareBooking, SquareCustomer } from "../square/types.js";

/**
 * Three contracts pinned here:
 * 1. The SAFE no-op the scheduler depends on: with no Square connections the
 *    sweep queries cleanly, ingests nothing, never throws.
 * 2. It walks the WHOLE window across pages, not just the first 100 - the
 *    exact bug acuity/walk.ts was extracted to kill.
 * 3. It re-reads idempotently, and it covers the FUTURE. Square bookings block
 *    native slots and drive the ~24h reminder, so a future booking the sweep
 *    can't see is a double-booking waiting to happen.
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
const WINDOW: SquareBooking[] = Array.from({ length: 250 }, (_, i) =>
  booking(i + 1, new Date(NOW.getTime() + i * 3600_000)),
);

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
      const min = p.startAtMin ? Date.parse(p.startAtMin) : 0;
      const max = p.startAtMax ? Date.parse(p.startAtMax) : Number.POSITIVE_INFINITY;
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

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("runSquareResync", () => {
  it("is a clean no-op when no shops have a Square connection", async () => {
    const existing = await prisma.squareConnection.count();
    if (existing === 0) {
      await expect(runSquareResync(NOW)).resolves.toEqual({
        shops: 0,
        ingested: 0,
        failedShops: 0,
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
      const shop = await prisma.shop.create({
        data: {
          ownerId: user.id,
          name: "Square Resync Shop",
          bookingMode: "square",
          webhookSecret: randomToken(),
        },
      });
      shopId = shop.id;
      // The client module is fully mocked, so the token fields are never read.
      await prisma.squareConnection.create({
        data: {
          shopId: shop.id,
          squareMerchantId: `m-${randomToken(6)}`,
          squareLocationId: "loc1",
          accessToken: "unused",
          refreshToken: "unused",
          tokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000),
        },
      });
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
  });
});
