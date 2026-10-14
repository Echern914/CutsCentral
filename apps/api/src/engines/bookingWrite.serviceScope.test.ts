import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  BlockedTimeError,
  lockStaffAndAssertSlotFree,
  lockStaffsAndAssertPartyFree,
} from "./bookingWrite.js";
import { dropBlockedTargetedSlots, partyMemberHitByServiceBlock, spanIsBlocked } from "./blockedTime.js";

/**
 * The write guard and a block that stops SOME services. The rule is
 * config/blockScope.ts; this pins the guard's use of it, under the lock:
 *
 *   matching service   - refused (BlockedTimeError)
 *   another service    - written
 *   service unknown    - refused (null: the safe answer)
 *   "ignore"           - the barber's own hand passes, as for any block
 *   party              - each member judged on ITS OWN span and service,
 *                        the turnover buffer only after the last member
 *
 * routes/serviceScopedBlocks.test.ts drives the same rule end to end.
 */
const DAY = 24 * 60 * 60 * 1000;
let shopId: string;
let ownerId: string;
let staffId: string;
let haircut: string;
let shapeUp: string;

/** `days` out at `hour`:`min` UTC. */
function at(days: number, hour: number, min = 0): Date {
  const d = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, min));
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: { email: `sscope-${randomToken(6)}@test.local`, passwordHash: "x", name: "Scope" },
      select: { id: true },
    })
  ).id;
  shopId = (
    await prisma.shop.create({
      data: {
        name: "Scope Guard",
        slug: `sscope-${randomToken(6)}`,
        ownerId,
        timezone: "UTC",
        bookingUrl: "https://sscope.test",
        webhookSecret: randomToken(),
      },
      select: { id: true },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  haircut = (await prisma.service.create({ data: { shopId, name: "Haircut", durationMin: 30 }, select: { id: true } })).id;
  shapeUp = (await prisma.service.create({ data: { shopId, name: "Shape-up", durationMin: 20 }, select: { id: true } })).id;
  // Day 5: Shape-ups off 15:00-18:00.
  await prisma.availabilityException.create({
    data: { shopId, staffId, startsAt: at(5, 15), endsAt: at(5, 18), isBlock: true, serviceIds: [shapeUp] },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

function guard(startsAt: Date, endsAt: Date, bookedServiceId: string | null, opts: { mode?: "ignore"; bufferMin?: number } = {}) {
  return prisma.$transaction((tx) =>
    lockStaffAndAssertSlotFree(tx, {
      staffId,
      shopId,
      startsAt,
      endsAt,
      bufferMin: opts.bufferMin ?? 0,
      bookedServiceId,
      serviceDayLimit: null,
      timezone: "UTC",
      walkInCapacity: "enforce",
      ...(opts.mode ? { nativeBlocks: opts.mode } : {}),
    }),
  );
}

describe("a block of some services, inside the write guard", () => {
  it("🔴 refuses the blocked service and writes any other over the same minutes", async () => {
    await expect(guard(at(5, 16), at(5, 16, 20), shapeUp)).rejects.toBeInstanceOf(BlockedTimeError);
    await expect(guard(at(5, 16), at(5, 16, 30), haircut)).resolves.toBeDefined();
  });

  it("🔴 a write that cannot name its service is refused, never guessed through", async () => {
    await expect(guard(at(5, 16), at(5, 16, 30), null)).rejects.toBeInstanceOf(BlockedTimeError);
  });

  it("uses the grid's edges: a Shape-up may end as it starts, and its turnover may not cross in", async () => {
    await expect(guard(at(5, 14, 40), at(5, 15), shapeUp)).resolves.toBeDefined();
    await expect(guard(at(5, 14, 40), at(5, 15), shapeUp, { bufferMin: 10 })).rejects.toBeInstanceOf(
      BlockedTimeError,
    );
    await expect(guard(at(5, 18), at(5, 18, 20), shapeUp)).resolves.toBeDefined();
  });

  it("the barber's own hand ignores it, like any block", async () => {
    await expect(guard(at(5, 16), at(5, 16, 20), shapeUp, { mode: "ignore" })).resolves.toBeDefined();
  });

  it("🔴 a party is judged member by member, not by its first member's service", async () => {
    const party = (spans: { start: Date; end: Date; serviceId: string }[]) =>
      prisma.$transaction((tx) =>
        lockStaffsAndAssertPartyFree(
          tx,
          spans.map((s) => ({ staffId, startsAt: s.start, endsAt: s.end, serviceId: s.serviceId })),
          { shopId, bufferMin: 0, serviceDayLimit: null, walkInCapacity: "enforce", timezone: "UTC" },
        ),
      );
    // Haircut first, Shape-up second and inside the block: refused.
    await expect(
      party([
        { start: at(5, 14, 40), end: at(5, 15, 10), serviceId: haircut },
        { start: at(5, 15, 10), end: at(5, 15, 30), serviceId: shapeUp },
      ]),
    ).rejects.toBeInstanceOf(BlockedTimeError);
    // Shape-up first and done by 15:00, Haircut inside: written.
    await expect(
      party([
        { start: at(5, 14, 40), end: at(5, 15), serviceId: shapeUp },
        { start: at(5, 15), end: at(5, 15, 30), serviceId: haircut },
      ]),
    ).resolves.toBeUndefined();
  });

  it("an all-services block still refuses every service and the whole party", async () => {
    await prisma.availabilityException.create({
      data: { shopId, staffId, startsAt: at(6, 15), endsAt: at(6, 18), isBlock: true },
    });
    await expect(guard(at(6, 16), at(6, 16, 30), haircut)).rejects.toBeInstanceOf(BlockedTimeError);
  });
});

describe("the read-side helpers apply the same rule", () => {
  const ranges = [{ start: 1_000, end: 2_000, serviceIds: ["shape"] }, { start: 5_000, end: 6_000 }];

  it("spanIsBlocked: scoped ranges stop only their services; unscoped ranges stop all", () => {
    expect(spanIsBlocked(ranges, 1_500, 1_600, "shape")).toBe(true);
    expect(spanIsBlocked(ranges, 1_500, 1_600, "cut")).toBe(false);
    expect(spanIsBlocked(ranges, 1_500, 1_600, null)).toBe(true);
    expect(spanIsBlocked(ranges, 5_500, 5_600, "cut")).toBe(true);
  });

  it("a special listed under a blocked service is dropped, even if it is also listed under another", () => {
    const base = { staffId: "s", startsAt: new Date(1_500), durationMin: 0.001 };
    const blocked = new Map([["s", ranges]]);
    expect(dropBlockedTargetedSlots([{ ...base, serviceId: "cut" }], blocked)).toHaveLength(1);
    expect(dropBlockedTargetedSlots([{ ...base, serviceId: "shape" }], blocked)).toHaveLength(0);
    expect(
      dropBlockedTargetedSlots([{ ...base, serviceId: "cut", services: [{ serviceId: "cut" }, { serviceId: "shape" }] }], blocked),
    ).toHaveLength(0);
  });

  it("partyMemberHitByServiceBlock names the member and buffers only the last", () => {
    const r = [{ start: 100 * 60_000, end: 200 * 60_000, serviceIds: ["shape"] }];
    const m = (s: number, e: number, serviceId: string) => ({
      startsAt: new Date(s * 60_000),
      endsAt: new Date(e * 60_000),
      serviceId,
    });
    expect(partyMemberHitByServiceBlock(r, [m(60, 90, "cut"), m(90, 110, "shape")], 0)?.serviceId).toBe("shape");
    // A Shape-up ending at 100 with a Haircut after it: no buffer between them.
    expect(partyMemberHitByServiceBlock(r, [m(80, 100, "shape"), m(100, 130, "cut")], 10)).toBeNull();
    // The same Shape-up LAST in the run carries the turnover into the block.
    expect(partyMemberHitByServiceBlock(r, [m(50, 80, "cut"), m(80, 100, "shape")], 10)?.serviceId).toBe("shape");
  });
});
