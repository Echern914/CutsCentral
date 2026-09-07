import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  ExternalBlockError,
  SlotTakenError,
  externalBlockConfirmation,
  lockStaffAndAssertSlotFree,
} from "./bookingWrite.js";

/**
 * The write guard and externally blocked time.
 *
 * Read/write parity was the first gap: the slot grid has always subtracted
 * ExternalBlock rows, but the atomic guard never looked at them, so a stale tab
 * or a hand-rolled POST could book straight into the barber's Acuity day off.
 *
 * The second gap was the SHAPE of the override. A boolean "yes, book over it"
 * authorises whatever happens to be in the way when the write lands - which is
 * not necessarily what the barber was shown and agreed to. So the guard takes a
 * CONFIRMATION BOUND TO THE CONFLICT: the digest of the exact blocks the
 * refusal named, recomputed here from the blocks read inside the lock. Pinned
 * below:
 *
 *   default/enforce  - refused, with the blocks attached AND the one
 *                      confirmation that would answer them
 *   matching confirm - crossed, detected and RETURNED so the caller records it
 *   stale confirm    - refused again, with the NEW conflict and a NEW digest
 *   ignore           - not looked for (paid-hold promotion, walk-in start)
 *
 * and the line that matters most: a confirmation is not a skeleton key. Every
 * other conflict - an appointment, a hold, an offer, a synced visit, a walk-in -
 * is decided ABOVE this check and throws a plain SlotTakenError that no
 * confirmation can answer.
 */
let shopId: string;
let staffId: string;
let serviceId: string;
let ownerId: string;
let blockId: string;

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
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  // 12:00-13:00 is blocked in Acuity.
  blockId = (
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12),
        endsAt: at(13),
        reason: "Dentist",
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

function guard(
  opts: { mode?: "enforce" | "ignore"; confirmation?: string },
  startsAt: Date,
  endsAt: Date,
) {
  return prisma.$transaction((tx) =>
    lockStaffAndAssertSlotFree(tx, {
      ...(opts.mode ? { externalBlocks: opts.mode } : {}),
      ...(opts.confirmation !== undefined ? { externalBlockConfirmation: opts.confirmation } : {}),
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

/** The confirmation the API would have handed back for whatever stands now. */
async function currentConfirmation(): Promise<string> {
  const err = await guard({}, at(12), at(12.5)).catch((e: unknown) => e);
  return (err as ExternalBlockError).confirmation;
}

describe("externally blocked time in the write guard", () => {
  it("🔴 refuses a write into a block by DEFAULT, naming it and offering its confirmation", async () => {
    const err = await guard({}, at(12), at(12.5)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalBlockError);
    // ...and it is still a SlotTakenError, so every public catch says "taken".
    expect(err).toBeInstanceOf(SlotTakenError);
    expect((err as Error).message).toBe("slot_taken");
    const blocks = (err as ExternalBlockError).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toBe("Dentist");
    expect(blocks[0]!.startsAt.toISOString()).toBe(at(12).toISOString());
    // The confirmation is the digest of THESE blocks - nothing else.
    expect((err as ExternalBlockError).confirmation).toBe(externalBlockConfirmation(blocks));
    expect((err as ExternalBlockError).confirmation).toMatch(/^[0-9a-f]{32}$/);
  });

  it("catches a PARTIAL overlap, not only a write wholly inside the block", async () => {
    // 12:30-13:30 straddles the block's end.
    await expect(
      guard({ mode: "enforce" }, new Date(at(12).getTime() + 30 * 60_000), at(13.5)),
    ).rejects.toBeInstanceOf(ExternalBlockError);
    // 11:30-12:00 ends exactly where the block starts: no overlap.
    await expect(guard({ mode: "enforce" }, at(11.5), at(12))).resolves.toEqual({
      externalBlocksCrossed: [],
    });
  });

  it("🔴 a confirmation matching THESE blocks crosses, and the crossing is returned", async () => {
    const result = await guard({ confirmation: await currentConfirmation() }, at(12), at(12.5));
    expect(result.externalBlocksCrossed).toHaveLength(1);
    expect(result.externalBlocksCrossed[0]!.reason).toBe("Dentist");
  });

  it("refuses an absent, empty or invented confirmation", async () => {
    for (const confirmation of ["", "   ", "0".repeat(32), "not-a-digest"]) {
      await expect(guard({ confirmation }, at(12), at(12.5))).rejects.toBeInstanceOf(
        ExternalBlockError,
      );
    }
  });

  it("🔴 a STALE confirmation cannot cross a conflict that has since changed", async () => {
    const stale = await currentConfirmation();
    // The barber's tab still shows "Dentist". Acuity syncs a SECOND block over
    // the same hour while it sits there.
    const second = await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at(12.25),
        endsAt: at(12.75),
        reason: "School run",
      },
      select: { id: true },
    });
    try {
      const err = await guard({ confirmation: stale }, at(12), at(12.5)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExternalBlockError);
      // Refused with the NEW conflict, which needs its own confirmation.
      const blocks = (err as ExternalBlockError).blocks;
      expect(blocks.map((b) => b.reason).sort()).toEqual(["Dentist", "School run"]);
      const fresh = (err as ExternalBlockError).confirmation;
      expect(fresh).not.toBe(stale);
      // And that fresh one does cross.
      const ok = await guard({ confirmation: fresh }, at(12), at(12.5));
      expect(ok.externalBlocksCrossed).toHaveLength(2);
    } finally {
      await prisma.externalBlock.delete({ where: { id: second.id } });
    }
  });

  it("🔴 a confirmation is bound to the block as it was SHOWN, reason included", async () => {
    const before = await currentConfirmation();
    // Same row, same window - the barber renamed it in Acuity. What the banner
    // said is no longer what the block says, so the answer no longer fits.
    await prisma.externalBlock.update({
      where: { id: blockId },
      data: { reason: "Dentist (moved)" },
    });
    try {
      await expect(guard({ confirmation: before }, at(12), at(12.5))).rejects.toBeInstanceOf(
        ExternalBlockError,
      );
    } finally {
      await prisma.externalBlock.update({ where: { id: blockId }, data: { reason: "Dentist" } });
    }
  });

  it("🔴 a valid confirmation cannot override an APPOINTMENT collision", async () => {
    // Someone is already booked at 12:00. The block is there too, and the
    // barber holds a perfectly good confirmation for it.
    const confirmation = await currentConfirmation();
    const taken = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Already",
        status: "BOOKED",
        startsAt: at(12),
        endsAt: at(12.5),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    try {
      const err = await guard({ confirmation }, at(12), at(12.5)).catch((e: unknown) => e);
      // A plain SlotTakenError - decided ABOVE the block check, so the
      // confirmation never even gets looked at.
      expect(err).toBeInstanceOf(SlotTakenError);
      expect(err).not.toBeInstanceOf(ExternalBlockError);
    } finally {
      await prisma.appointment.delete({ where: { id: taken.id } });
    }
  });

  it("in ignore mode does not look, and reports nothing crossed", async () => {
    const result = await guard({ mode: "ignore" }, at(12), at(12.5));
    expect(result.externalBlocksCrossed).toEqual([]);
  });

  it("reports nothing crossed on a free span, in every mode", async () => {
    for (const mode of ["enforce", "ignore"] as const) {
      expect((await guard({ mode }, at(9), at(9.5))).externalBlocksCrossed).toEqual([]);
    }
  });
});

describe("the confirmation digest itself", () => {
  const span = (over: Partial<{ id: string; externalId: string; reason: string | null }> = {}) => ({
    id: "blk_1",
    externalId: "acuity:1",
    startsAt: new Date("2026-09-10T12:00:00.000Z"),
    endsAt: new Date("2026-09-10T14:00:00.000Z"),
    reason: "Dentist" as string | null,
    ...over,
  });

  it("is stable for the same conflict and independent of row order", () => {
    const a = span();
    const b = span({ id: "blk_2", externalId: "acuity:2", reason: "School run" });
    expect(externalBlockConfirmation([a, b])).toBe(externalBlockConfirmation([b, a]));
    expect(externalBlockConfirmation([a])).toBe(externalBlockConfirmation([span()]));
  });

  it("moves when the id, the span or the reason moves", () => {
    const base = externalBlockConfirmation([span()]);
    expect(externalBlockConfirmation([span({ id: "blk_9" })])).not.toBe(base);
    expect(externalBlockConfirmation([span({ reason: "Away" })])).not.toBe(base);
    expect(externalBlockConfirmation([span({ reason: null })])).not.toBe(base);
    expect(
      externalBlockConfirmation([{ ...span(), endsAt: new Date("2026-09-10T15:00:00.000Z") }]),
    ).not.toBe(base);
    // One extra block in the way is a different conflict.
    expect(externalBlockConfirmation([span(), span({ id: "blk_2" })])).not.toBe(base);
  });
});
