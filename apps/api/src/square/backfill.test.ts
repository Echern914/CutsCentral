import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * One whole-book import per shop at a time. The connect callback starts one,
 * and the sweep's next tick would start a second while the first is still
 * walking years of history - twice the Square calls, and two writers racing on
 * the same Visit rows.
 *
 * The first import is HELD mid-walk (a gate inside Square's list call) while
 * the second is attempted, so the overlap is real rather than hoped for.
 */

let openGate: () => void = () => {};
let gate = new Promise<void>((resolve) => (openGate = resolve));
let reachedSquare: () => void = () => {};
const inSquare = new Promise<void>((resolve) => (reachedSquare = resolve));
let listCalls = 0;

vi.mock("./client.js", () => ({
  getSquareClientForShop: vi.fn(async () => ({
    getBooking: async () => {
      throw new Error("not used");
    },
    getCustomer: async () => {
      throw new Error("not used");
    },
    listBookings: async () => {
      listCalls++;
      reachedSquare();
      await gate;
      return { bookings: [], cursor: null };
    },
  })),
  squareEnabled: () => true,
  NotConnectedError: class extends Error {},
  SquareError: class extends Error {},
}));

const { backfillSquareShop } = await import("./backfill.js");

let userId: string;
let shopId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqbf-${randomToken(6)}@test.local`, passwordHash: "x", name: "SQBF" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: user.id, name: "Square Backfill Shop", webhookSecret: randomToken() },
  });
  shopId = shop.id;
  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: `m-${randomToken(6)}`,
      squareLocationId: "loc1",
      accessToken: "unused",
      refreshToken: "unused",
      tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
    },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("backfillSquareShop", () => {
  it("🔴 a second import while the first is still walking starts nothing", async () => {
    const first = backfillSquareShop(shopId);
    await inSquare; // the first is inside Square's list call, and held there
    const callsBefore = listCalls;

    await expect(backfillSquareShop(shopId)).resolves.toBeNull();
    expect(listCalls).toBe(callsBefore); // the second never reached Square

    openGate();
    await expect(first).resolves.toBe(0);
    const conn = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId } });
    expect(conn.backfilledAt).not.toBeNull();
    expect(conn.lastSyncError).toBeNull();
  });

  it("walks the whole book in slices Square accepts - 2015 to a year ahead", async () => {
    // The gate is open now; every slice answers at once.
    listCalls = 0;
    await expect(backfillSquareShop(shopId)).resolves.toBe(0);
    expect(listCalls).toBeGreaterThan(150);
  });

  it("once it has finished, the next import may start", async () => {
    gate = Promise.resolve();
    await expect(backfillSquareShop(shopId)).resolves.toBe(0);
  });
});
