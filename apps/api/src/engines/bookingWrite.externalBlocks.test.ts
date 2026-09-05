import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { ExternalBlockError, SlotTakenError, lockStaffAndAssertSlotFree } from "./bookingWrite.js";

/**
 * The write guard and externally blocked time.
 *
 * Read/write parity was the gap: the slot grid has always subtracted
 * ExternalBlock rows, but the atomic guard never looked at them, so a stale tab
 * or a hand-rolled POST could book straight into the barber's Acuity day off.
 * Three modes now, each pinned here:
 *
 *   enforce  - the default: the write is refused, with the blocks attached so
 *              the dashboard can name them
 *   override - detected and RETURNED, never thrown: the caller records it
 *   ignore   - not looked for (paid-hold promotion, walk-in start)
 */
let shopId: string;
let staffId: string;
let ownerId: string;

/** Five days out at `h` UTC; fractional hours are minutes (12.5 = 12:30). */
const at = (h: number) => {
  const d = new Date(Date.now() + 5 * 86_400_000);
  d.setUTCHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  return d;
};

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `blk-${randomToken(6)}@test.local`, passwordHash: "x", name: "Blk" },
    select: { id: true },
  });
  ownerId = owner.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Block Guard",
      slug: `blk-${randomToken(6)}`,
      ownerId,
      timezone: "UTC",
      bookingUrl: "https://blk.test",
      webhookSecret: randomToken(),
    },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  // 12:00-13:00 is blocked in Acuity.
  await prisma.externalBlock.create({
    data: {
      shopId,
      externalId: `acuity:${randomToken(6)}`,
      startsAt: at(12),
      endsAt: at(13),
      reason: "Dentist",
    },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

function guard(mode: "enforce" | "override" | "ignore" | undefined, startsAt: Date, endsAt: Date) {
  return prisma.$transaction((tx) =>
    lockStaffAndAssertSlotFree(tx, {
      ...(mode ? { externalBlocks: mode } : {}),
      walkInCapacity: "ignore",
      serviceDayLimit: null,
      staffId,
      shopId,
      startsAt,
      endsAt,
      bufferMin: 0,
    }),
  );
}

describe("externally blocked time in the write guard", () => {
  it("🔴 refuses a write into a block by DEFAULT, naming the block", async () => {
    const err = await guard(undefined, at(12), at(12.5)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalBlockError);
    // ...and it is still a SlotTakenError, so every public catch says "taken".
    expect(err).toBeInstanceOf(SlotTakenError);
    expect((err as Error).message).toBe("slot_taken");
    const blocks = (err as ExternalBlockError).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toBe("Dentist");
    expect(blocks[0]!.startsAt.toISOString()).toBe(at(12).toISOString());
  });

  it("catches a PARTIAL overlap, not only a write wholly inside the block", async () => {
    // 12:30-13:30 straddles the block's end.
    await expect(guard("enforce", new Date(at(12).getTime() + 30 * 60_000), at(13.5))).rejects.toBeInstanceOf(
      ExternalBlockError,
    );
    // 11:30-12:00 ends exactly where the block starts: no overlap.
    await expect(guard("enforce", at(11.5), at(12))).resolves.toEqual({ externalBlocksCrossed: [] });
  });

  it("in override mode detects the crossing and RETURNS it instead of throwing", async () => {
    const result = await guard("override", at(12), at(12.5));
    expect(result.externalBlocksCrossed).toHaveLength(1);
    expect(result.externalBlocksCrossed[0]!.reason).toBe("Dentist");
  });

  it("in ignore mode does not look, and reports nothing crossed", async () => {
    const result = await guard("ignore", at(12), at(12.5));
    expect(result.externalBlocksCrossed).toEqual([]);
  });

  it("reports nothing crossed on a free span, in every mode", async () => {
    for (const mode of ["enforce", "override", "ignore"] as const) {
      expect((await guard(mode, at(9), at(9.5))).externalBlocksCrossed).toEqual([]);
    }
  });
});
