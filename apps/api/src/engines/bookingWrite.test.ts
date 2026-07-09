import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";

/**
 * The ONE shared double-booking guard (extracted from the five write sites).
 * Covers the PR #70 regression shape - DIFFERENT-start overlaps, not just
 * exact-start (which the partial unique already catches) - plus the
 * receptionist-hold predicate and the status/self-exclusion knobs.
 */

const NOW = new Date("2026-06-01T16:00:00Z");
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 2, h, m)); // June 2

let shopId: string;
let staffId: string;
let serviceId: string;
let userId: string;

async function seedAppt(opts: {
  startsAt: Date;
  endsAt: Date;
  status?: "BOOKED" | "PENDING";
  holdExpiresAt?: Date | null;
}): Promise<string> {
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Seed",
      status: opts.status ?? "BOOKED",
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      holdExpiresAt: opts.holdExpiresAt ?? null,
      bookedVia: opts.holdExpiresAt ? "receptionist" : null,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

function assertFree(opts: {
  startsAt: Date;
  endsAt: Date;
  bufferMin?: number;
  excludeAppointmentId?: string;
  statuses?: readonly ("BOOKED" | "PENDING")[];
}): Promise<void> {
  return prisma.$transaction((tx) =>
    lockStaffAndAssertSlotFree(tx, {
      staffId,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      bufferMin: opts.bufferMin ?? 0,
      excludeAppointmentId: opts.excludeAppointmentId,
      statuses: opts.statuses,
      now: NOW,
    }),
  );
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `guard-${randomToken(6)}@test.chairback`, name: "Guard" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Guard Cuts",
      slug: `guard-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "G" } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
  });
  serviceId = service.id;
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
});

describe("lockStaffAndAssertSlotFree", () => {
  it("throws SlotTakenError on a DIFFERENT-start overlap (the PR #70 shape)", async () => {
    await seedAppt({ startsAt: T(14, 0), endsAt: T(14, 30) });
    // 14:15-14:45 overlaps 14:00-14:30 but starts differently - the partial
    // unique can't catch this; only the guard can.
    await expect(assertFree({ startsAt: T(14, 15), endsAt: T(14, 45) })).rejects.toThrow(
      SlotTakenError,
    );
    // Error message stays "slot_taken" for the string-matching call sites.
    await expect(assertFree({ startsAt: T(14, 15), endsAt: T(14, 45) })).rejects.toThrow(
      "slot_taken",
    );
    // A non-overlapping slot right after passes.
    await expect(assertFree({ startsAt: T(14, 30), endsAt: T(15, 0) })).resolves.toBeUndefined();
  });

  it("pads both sides by the turnover buffer", async () => {
    await seedAppt({ startsAt: T(9, 0), endsAt: T(9, 30) });
    // 9:40 start clears the appointment but NOT a 15-min buffer after it.
    await expect(
      assertFree({ startsAt: T(9, 40), endsAt: T(10, 10), bufferMin: 15 }),
    ).rejects.toThrow(SlotTakenError);
    await expect(
      assertFree({ startsAt: T(9, 45), endsAt: T(10, 15), bufferMin: 15 }),
    ).resolves.toBeUndefined();
  });

  it("excludeAppointmentId ignores the row's own slot (reschedule/approve)", async () => {
    const id = await seedAppt({ startsAt: T(11, 0), endsAt: T(11, 30) });
    await expect(assertFree({ startsAt: T(11, 0), endsAt: T(11, 30) })).rejects.toThrow();
    await expect(
      assertFree({ startsAt: T(11, 0), endsAt: T(11, 30), excludeAppointmentId: id }),
    ).resolves.toBeUndefined();
  });

  it("PENDING blocks by default; statuses:['BOOKED'] ignores it (approve path)", async () => {
    await seedAppt({ startsAt: T(12, 0), endsAt: T(12, 30), status: "PENDING" });
    await expect(assertFree({ startsAt: T(12, 0), endsAt: T(12, 30) })).rejects.toThrow();
    await expect(
      assertFree({ startsAt: T(12, 0), endsAt: T(12, 30), statuses: ["BOOKED"] }),
    ).resolves.toBeUndefined();
  });

  it("an ACTIVE receptionist hold blocks; an EXPIRED one releases the slot", async () => {
    await seedAppt({
      startsAt: T(15, 0),
      endsAt: T(15, 30),
      status: "PENDING",
      holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000), // live
    });
    await expect(assertFree({ startsAt: T(15, 0), endsAt: T(15, 30) })).rejects.toThrow(
      SlotTakenError,
    );

    await seedAppt({
      startsAt: T(16, 0),
      endsAt: T(16, 30),
      status: "PENDING",
      holdExpiresAt: new Date(NOW.getTime() - 60_000), // lapsed
    });
    await expect(
      assertFree({ startsAt: T(16, 0), endsAt: T(16, 30) }),
    ).resolves.toBeUndefined();
  });
});
