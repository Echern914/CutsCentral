import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { AcuityAppointment } from "./types.js";

/**
 * Backfill date-cursor walk. We mock listAppointments to serve paged history by
 * minDate and assert: every appointment is ingested, the cursor advances across
 * pages, a short page terminates, and a re-run produces no duplicates.
 */

function appt(id: number, iso: string): AcuityAppointment {
  return {
    id: String(id),
    firstName: `C${id}`,
    phone: `30255500${String(id).padStart(2, "0")}`,
    datetime: iso,
    endTime: iso,
    canceled: false,
    noShow: false,
    type: "Haircut",
  };
}

// 250 active appointments across 2026, spaced a day apart -> spans >1 page (200).
const ACTIVE: AcuityAppointment[] = Array.from({ length: 250 }, (_, i) =>
  appt(i + 1, new Date(Date.UTC(2026, 0, 1 + i, 15)).toISOString()),
);

vi.mock("./client.js", () => ({
  getAcuityClientForShop: vi.fn(async () => ({
    me: async () => ({ id: "acct" }),
    getAppointment: async (id: string) => ACTIVE.find((a) => a.id === id)!,
    listAppointments: async (p: { minDate?: string; max?: number; canceled?: boolean }) => {
      if (p.canceled) return []; // no canceled history
      const min = p.minDate ? new Date(p.minDate).getTime() : 0;
      return ACTIVE.filter((a) => new Date(a.datetime).getTime() >= min).slice(
        0,
        p.max ?? 100,
      );
    },
  })),
  NotConnectedError: class extends Error {},
  AcuityError: class extends Error {},
}));

const { backfillShop } = await import("./backfill.js");

let userId: string;
let shopId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `bf-${randomToken(6)}@test.local`, passwordHash: "x", name: "BF" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: userId, name: "BF Shop", bookingUrl: "https://bf.test", webhookSecret: randomToken() },
  });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

// 250 appointments x one runWithShop transaction each (~7 round trips) against
// the remote DB far exceeds the 30s default - this is an integration test.
const BACKFILL_TIMEOUT = 180_000;

describe("backfillShop date-cursor walk", () => {
  it(
    "ingests all appointments across multiple pages",
    async () => {
      await backfillShop(shopId);
      expect(await prisma.visit.count({ where: { shopId } })).toBe(250);
    },
    BACKFILL_TIMEOUT,
  );

  it(
    "is idempotent - a re-run creates no duplicates",
    async () => {
      await backfillShop(shopId);
      expect(await prisma.visit.count({ where: { shopId } })).toBe(250);
    },
    BACKFILL_TIMEOUT,
  );

  it(
    "synced clients have NO SMS consent by default (not textable)",
    async () => {
      // The whole TCPA safety guarantee: importing from Acuity must never make
      // a client textable. Every synced client lands with smsConsentAt = null.
      const total = await prisma.client.count({ where: { shopId } });
      expect(total).toBeGreaterThan(0);
      const withConsent = await prisma.client.count({
        where: { shopId, smsConsentAt: { not: null } },
      });
      expect(withConsent).toBe(0);
    },
    BACKFILL_TIMEOUT,
  );
});
