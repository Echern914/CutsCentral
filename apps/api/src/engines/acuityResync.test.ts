import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { AcuityAppointment } from "../acuity/types.js";

/**
 * Two contracts pinned here:
 * 1. The SAFE no-op the scheduler depends on: with no Acuity connections the
 *    sweep queries cleanly, ingests nothing, never throws.
 * 2. The PAGE WALK actually reads a whole window. The old walk stopped on
 *    `page.length < 200`, and the real Acuity caps pages at 100 - so every
 *    resync silently synced at most 100 appointments per pass and shops
 *    reported "it only syncs partway through". The mock server below caps at
 *    100 exactly like production Acuity.
 */

function appt(id: number, iso: string): AcuityAppointment {
  return {
    id: String(id),
    firstName: `R${id}`,
    phone: `30255511${String(id).padStart(2, "0")}`,
    datetime: iso,
    endTime: iso,
    canceled: false,
    noShow: false,
    type: "Haircut",
  } as AcuityAppointment;
}

// 250 appointments spread over the resync window (starting "now", one per
// hour) - forces 3+ pages against a 100-cap server.
const NOW = new Date("2026-08-05T12:00:00Z");
const WINDOW: AcuityAppointment[] = Array.from({ length: 250 }, (_, i) =>
  appt(i + 1, new Date(NOW.getTime() + i * 3600_000).toISOString()),
);

vi.mock("../acuity/client.js", () => ({
  getAcuityClientForShop: vi.fn(async () => ({
    me: async () => ({ id: "acct" }),
    getAppointment: async (id: string) => WINDOW.find((a) => a.id === id)!,
    listAppointments: async (p: {
      minDate?: string;
      maxDate?: string;
      max?: number;
      canceled?: boolean;
    }) => {
      if (p.canceled) return [];
      const min = p.minDate ? new Date(p.minDate).getTime() : 0;
      const max = p.maxDate
        ? new Date(p.maxDate).getTime() + 24 * 3600_000
        : Number.POSITIVE_INFINITY;
      // Production Acuity caps max at 100 no matter what is requested.
      return WINDOW.filter((a) => {
        const t = new Date(a.datetime).getTime();
        return t >= min && t <= max;
      }).slice(0, Math.min(p.max ?? 100, 100));
    },
  })),
  NotConnectedError: class extends Error {},
  AcuityError: class extends Error {},
}));

const { runAcuityResync } = await import("./acuityResync.js");

let userId: string | null = null;
let shopId: string | null = null;

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("runAcuityResync", () => {
  it("is a clean no-op when no shops have an Acuity connection", async () => {
    const existing = await prisma.acuityConnection.count();
    if (existing === 0) {
      await expect(runAcuityResync(NOW)).resolves.toBe(0);
    } else {
      await expect(runAcuityResync(NOW)).resolves.toEqual(expect.any(Number));
    }
  });

  describe("page walk against a 100-cap server", () => {
    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          email: `rs-${randomToken(6)}@test.local`,
          passwordHash: "x",
          name: "RS",
        },
      });
      userId = user.id;
      const shop = await prisma.shop.create({
        data: {
          ownerId: user.id,
          name: "Resync Shop",
          bookingUrl: "https://rs.test",
          webhookSecret: randomToken(),
        },
      });
      shopId = shop.id;
      // The client module is fully mocked, so the token fields are never read.
      await prisma.acuityConnection.create({
        data: {
          shopId: shop.id,
          acuityAccountId: "acct",
          accessToken: "unused",
        },
      });
    });

    // 250 appointments x a runWithShop tx each - integration-slow, like backfill.
    const RESYNC_TIMEOUT = 180_000;

    it(
      "ingests the WHOLE window across pages, not just the first 100",
      async () => {
        const n = await runAcuityResync(NOW);
        expect(n).toBe(250);
        expect(await prisma.visit.count({ where: { shopId: shopId! } })).toBe(250);
      },
      RESYNC_TIMEOUT,
    );

    it(
      "is idempotent - a second sweep re-reads but creates no duplicates",
      async () => {
        await runAcuityResync(NOW);
        expect(await prisma.visit.count({ where: { shopId: shopId! } })).toBe(250);
      },
      RESYNC_TIMEOUT,
    );
  });
});
