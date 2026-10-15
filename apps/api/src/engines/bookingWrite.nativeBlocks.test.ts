import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import {
  BlockedTimeError,
  SlotTakenError,
  lockStaffAndAssertSlotFree,
} from "./bookingWrite.js";

/**
 * The write guard and time the barber blocked off IN CHAIRBACK.
 *
 * The slot grid has always subtracted a barber's one-off blocks and weekly
 * breaks, but the locked writer never looked at them - so a block committed
 * between a customer's slot check and the write let the booking land inside
 * it. These pin the guard itself; routes/blockOffJourney.test.ts races it end
 * to end on the real routes.
 *
 *   default            - refused (BlockedTimeError, still a SlotTakenError)
 *   trailing buffer    - the grid's rule: the cut plus its turnover may not
 *                        touch the block; a cut may start the minute it ends
 *   "ignore"           - the barber's own writes pass, as they always have
 *   open window        - isBlock:false is not a block
 *   another chair      - one barber's block does not refuse another's write
 *   weekly break       - placed on the SHOP-local weekday; no zone = refuse
 */
const TZ = "America/New_York";
let shopId: string;
let staffId: string;
let otherStaffId: string;
let serviceId: string;
let ownerId: string;

/** Shop-local wall time, `days` days out, as a UTC instant. */
function local(days: number, minutes: number): Date {
  const p = zonedDateParts(new Date(Date.now() + days * 86_400_000), TZ);
  return zonedWallTimeToUtc(p.year, p.month0, p.day, minutes, TZ);
}
const H = 60;

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: { email: `nblk-${randomToken(6)}@test.local`, passwordHash: "x", name: "Nblk" },
      select: { id: true },
    })
  ).id;
  shopId = (
    await prisma.shop.create({
      data: {
        name: "Native Block Guard",
        slug: `nblk-${randomToken(6)}`,
        ownerId,
        timezone: TZ,
        bookingUrl: "https://nblk.test",
        webhookSecret: randomToken(),
      },
      select: { id: true },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  otherStaffId = (await prisma.staff.create({ data: { shopId, name: "Lee" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  // Day 5: blocked 12:00-13:00 local. Day 6: an OPEN window 12:00-13:00.
  await prisma.availabilityException.createMany({
    data: [
      { shopId, staffId, startsAt: local(5, 12 * H), endsAt: local(5, 13 * H), isBlock: true },
      { shopId, staffId, startsAt: local(6, 12 * H), endsAt: local(6, 13 * H), isBlock: false },
    ],
  });
  // Day 8: a weekly 15:00-16:00 break on that day's shop-local weekday.
  await prisma.recurringBlock.create({
    data: {
      shopId,
      staffId,
      weekday: zonedDateParts(local(8, 12 * H), TZ).weekday,
      startMin: 15 * H,
      endMin: 16 * H,
    },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

function guard(
  startsAt: Date,
  endsAt: Date,
  opts: {
    mode?: "enforce" | "ignore";
    staff?: string;
    bufferMin?: number;
    zone?: "service" | "explicit" | "none";
  } = {},
) {
  const zone = opts.zone ?? "service";
  return prisma.$transaction((tx) =>
    lockStaffAndAssertSlotFree(tx, {
      bookedServiceId: null,
      ...(opts.mode ? { nativeBlocks: opts.mode } : {}),
      ...(zone === "explicit" ? { timezone: TZ } : {}),
      // A customer write: the cap object carries the shop's zone.
      serviceDayLimit: zone === "service" ? { serviceId, timezone: TZ } : null,
      walkInCapacity: "enforce",
      staffId: opts.staff ?? staffId,
      shopId,
      startsAt,
      endsAt,
      bufferMin: opts.bufferMin ?? 0,
    }),
  );
}

describe("time blocked off in ChairBack, inside the write guard", () => {
  it("🔴 refuses a write into a one-off block by DEFAULT, as a plain slot_taken", async () => {
    const err = await guard(local(5, 12 * H + 15), local(5, 12 * H + 45)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedTimeError);
    // Every public catch keeps saying "taken".
    expect(err).toBeInstanceOf(SlotTakenError);
    expect((err as Error).message).toBe("slot_taken");
  });

  it("catches a PARTIAL overlap at either edge", async () => {
    await expect(guard(local(5, 11 * H + 45), local(5, 12 * H + 15))).rejects.toBeInstanceOf(
      BlockedTimeError,
    );
    await expect(guard(local(5, 12 * H + 45), local(5, 13 * H + 15))).rejects.toBeInstanceOf(
      BlockedTimeError,
    );
  });

  it("matches the grid at the edges: the turnover after a cut may not touch the block, a cut may start as it ends", async () => {
    // 11:30-12:00 ends exactly at the block: fine with no buffer...
    await expect(guard(local(5, 11 * H + 30), local(5, 12 * H))).resolves.toBeDefined();
    // ...refused with a 10-minute turnover that would run into it.
    await expect(
      guard(local(5, 11 * H + 30), local(5, 12 * H), { bufferMin: 10 }),
    ).rejects.toBeInstanceOf(BlockedTimeError);
    // 13:00 is the minute the block ends - bookable, buffer or not.
    await expect(
      guard(local(5, 13 * H), local(5, 13 * H + 30), { bufferMin: 10 }),
    ).resolves.toBeDefined();
  });

  it("lets the barber's own writes through with nativeBlocks: 'ignore'", async () => {
    await expect(
      guard(local(5, 12 * H), local(5, 12 * H + 30), { mode: "ignore" }),
    ).resolves.toBeDefined();
  });

  it("an OPEN window (isBlock:false) is not a block", async () => {
    await expect(guard(local(6, 12 * H), local(6, 12 * H + 30))).resolves.toBeDefined();
  });

  it("one barber's block does not refuse another barber's chair", async () => {
    await expect(
      guard(local(5, 12 * H), local(5, 12 * H + 30), { staff: otherStaffId }),
    ).resolves.toBeDefined();
  });

  it("🔴 refuses a write into a WEEKLY break, placed on the shop-local weekday", async () => {
    await expect(guard(local(8, 15 * H + 15), local(8, 15 * H + 45))).rejects.toBeInstanceOf(
      BlockedTimeError,
    );
    // An explicit zone (a write with no cap) places it the same way.
    await expect(
      guard(local(8, 15 * H + 15), local(8, 15 * H + 45), { zone: "explicit" }),
    ).rejects.toBeInstanceOf(BlockedTimeError);
    // The hour before it is open.
    await expect(guard(local(8, 14 * H), local(8, 14 * H + 30))).resolves.toBeDefined();
    // ...and the same hour a day later is not that weekday.
    await expect(guard(local(9, 15 * H + 15), local(9, 15 * H + 45))).resolves.toBeDefined();
  });

  it("refuses rather than guesses when it cannot tell where a weekly break falls", async () => {
    // No zone anywhere, and this chair HAS a weekly break: refused even at an
    // hour the break does not cover, because nothing says which hour that is.
    await expect(
      guard(local(8, 9 * H), local(8, 9 * H + 30), { zone: "none" }),
    ).rejects.toBeInstanceOf(BlockedTimeError);
    // A chair with no weekly break needs no zone.
    await expect(
      guard(local(8, 9 * H), local(8, 9 * H + 30), { zone: "none", staff: otherStaffId }),
    ).resolves.toBeDefined();
  });
});
