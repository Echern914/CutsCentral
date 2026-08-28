import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { computeFreeRanges, computeOpenSlots, isSlotBookable } from "./slots.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";

/**
 * Walk-in capacity: an ASSIGNED/READY walk-in holds its projected span against
 * the PUBLIC slot grid AND against the booking write guard - one plan
 * (engines/walkInCapacity.ts), enforced on both sides, so what the grid hides
 * cannot be taken by a stale grid or a hand-rolled POST a second later.
 *
 *   - the GRID subtraction is gated on Shop.walkInEnabled (other shops' hot
 *     path: zero queries) and runs in service-grid mode only (the walk-in
 *     estimate engine simulates these entries itself - blocking there too
 *     would double-count);
 *   - the WRITE guard enforces for customer-driven writes, is ignored for
 *     barber-driven ones (their calendar, same as overrideWaitlistHolds), and
 *     excludes only its OWN entry for Walk-In Start;
 *   - released the instant the entry leaves ASSIGNED/READY, or is reassigned
 *     to another chair - the span is derived from status, nothing is stored.
 */

let userId: string;
let shopId: string;
let chairA: string;
let svc30: string;
let entrySeq = 0;

// Wednesday 14:00 UTC in a UTC shop working 9-17 (weekday 3 rules).
const NOW = new Date("2026-09-02T14:00:00.000Z");
const at = (hhmm: string) => new Date(`2026-09-02T${hhmm}:00.000Z`);

async function reservation(status: "ASSIGNED" | "READY" | "LEFT", durationMin = 30) {
  entrySeq += 1;
  const e = await prisma.walkInEntry.create({
    data: {
      shopId,
      firstName: `R${entrySeq}`,
      source: "STAFF",
      status,
      position: entrySeq * 1024,
      assignedStaffId: status === "LEFT" ? null : chairA,
      joinedAt: NOW,
      ...(status !== "LEFT" ? { assignedAt: NOW } : { leftAt: NOW }),
    },
  });
  await prisma.walkInEntryService.create({
    data: {
      shopId,
      entryId: e.id,
      serviceId: svc30,
      nameAtJoin: "Fade",
      durationMinAtJoin: durationMin,
      priceAtJoin: 40,
      sortOrder: 0,
    },
  });
  return e;
}

/** The write guard, run the way every booking path runs it: in one tx. */
function guard(opts: {
  startsAt: Date;
  endsAt: Date;
  walkInCapacity: "enforce" | "ignore" | { excludeEntryId: string };
  bufferMin?: number;
}): Promise<void> {
  return prisma.$transaction((tx) =>
    lockStaffAndAssertSlotFree(tx, {
      walkInCapacity: opts.walkInCapacity,
      serviceDayLimit: null,
      staffId: chairA,
      shopId,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      bufferMin: opts.bufferMin ?? 0,
      now: NOW,
    }),
  );
}

async function offeredStarts(): Promise<string[]> {
  const slots = await computeOpenSlots({
    shopId,
    staffId: chairA,
    serviceId: svc30,
    fromDate: at("13:00"),
    toDate: at("16:00"),
    now: NOW,
  });
  return slots.map((s) => s.startsAt.toISOString());
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wr-${randomToken(6)}@test.local`, name: "WR" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Reserve Cuts",
      slug: `wr-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      bookingBufferMin: 0,
      bookingLeadHours: 0,
      walkInEnabled: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Ava" } })).id;
  svc30 = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: svc30, staffId: chairA },
  });
  await prisma.availabilityRule.create({
    data: { shopId, staffId: chairA, weekday: 3, startMin: 540, endMin: 1020 },
  });
});

afterEach(async () => {
  await prisma.walkInEntry.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { walkInEnabled: true },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("the public grid", () => {
  it("an ASSIGNED walk-in hides exactly its projected span from the grid", async () => {
    const before = await offeredStarts();
    expect(before).toContain(at("14:00").toISOString());
    await reservation("ASSIGNED");
    const after = await offeredStarts();
    // [14:00, 14:30) is spoken for; 14:30 onward still sells.
    expect(after).not.toContain(at("14:00").toISOString());
    expect(after).toContain(at("14:30").toISOString());
  });

  it("two reservations STACK sequentially - an hour of the chair, not one overlapping half-hour", async () => {
    await reservation("ASSIGNED");
    await reservation("READY");
    const starts = await offeredStarts();
    expect(starts).not.toContain(at("14:00").toISOString());
    expect(starts).not.toContain(at("14:30").toISOString());
    expect(starts).toContain(at("15:00").toISOString());
  });

  it("a terminal entry releases its span instantly - nothing is stored", async () => {
    const e = await reservation("ASSIGNED");
    await prisma.walkInEntry.update({
      where: { id: e.id },
      data: { status: "LEFT", leftAt: NOW },
    });
    expect(await offeredStarts()).toContain(at("14:00").toISOString());
  });

  it("a shop with Walk-In Mode off is untouched (the gate = zero queries)", async () => {
    await reservation("ASSIGNED");
    await prisma.shop.update({
      where: { id: shopId },
      data: { walkInEnabled: false },
    });
    expect(await offeredStarts()).toContain(at("14:00").toISOString());
  });
});

describe("what the reservation deliberately does NOT touch", () => {
  it("walk-in estimate mode (serviceId null) sees the same free time either way - no double-count", async () => {
    const bare = await computeFreeRanges({
      shopId,
      staffId: chairA,
      serviceId: null,
      fromDate: NOW,
      toDate: at("17:00"),
      now: NOW,
      ignoreLeadTime: true,
    });
    await reservation("ASSIGNED");
    const withEntry = await computeFreeRanges({
      shopId,
      staffId: chairA,
      serviceId: null,
      fromDate: NOW,
      toDate: at("17:00"),
      now: NOW,
      ignoreLeadTime: true,
    });
    expect(withEntry!.free).toEqual(bare!.free);
  });

  it("the availability pre-check (ignoreBooked) stays appointment-based - the WRITE GUARD is what refuses", async () => {
    await reservation("ASSIGNED");
    // isSlotBookable answers "is this instant within bookable availability",
    // and under ignoreBooked it skips walk-ins for exactly the reason it skips
    // existing appointments: occupancy is the guard's job, not availability's.
    // So this still says true...
    expect(
      await isSlotBookable({
        shopId,
        staffId: chairA,
        serviceId: svc30,
        startsAt: at("14:00"),
        now: NOW,
      }),
    ).toBe(true);
    // ...and the write is refused anyway, one layer down. That is the ONLY
    // layer a direct API submission cannot skip.
    await expect(
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "enforce" }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});

describe("the write guard", () => {
  it("🔴 an ASSIGNED walk-in refuses a conflicting public write, and only that span", async () => {
    await reservation("ASSIGNED");
    await expect(
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "enforce" }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    // The very next slot is untouched - this reserves a span, not a day.
    await expect(
      guard({ startsAt: at("14:30"), endsAt: at("15:00"), walkInCapacity: "enforce" }),
    ).resolves.toBeUndefined();
  });

  it("a READY walk-in holds the chair exactly like an ASSIGNED one", async () => {
    await reservation("READY");
    await expect(
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "enforce" }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("🔴 the refusal never reveals that a queue exists", async () => {
    await reservation("ASSIGNED");
    const err = await guard({
      startsAt: at("14:00"),
      endsAt: at("14:30"),
      walkInCapacity: "enforce",
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    // Byte-identical to every other taken slot: same class, same message. An
    // anonymous caller learns that the time is gone and nothing else - not
    // that a walk-in queue exists, not who is in it, not how long it is.
    expect(err).toBeInstanceOf(SlotTakenError);
    expect(err!.message).toBe("slot_taken");
    expect(JSON.stringify(err)).not.toMatch(/walk|queue|entry/i);
  });

  it("reservations STACK on the write side exactly as they do on the grid", async () => {
    await reservation("ASSIGNED");
    await reservation("READY");
    for (const t of ["14:00", "14:30"]) {
      await expect(
        guard({
          startsAt: at(t),
          endsAt: new Date(at(t).getTime() + 30 * 60_000),
          walkInCapacity: "enforce",
        }),
      ).rejects.toBeInstanceOf(SlotTakenError);
    }
    await expect(
      guard({ startsAt: at("15:00"), endsAt: at("15:30"), walkInCapacity: "enforce" }),
    ).resolves.toBeUndefined();
  });

  it("a BARBER-driven write overrides the projection - it is their calendar", async () => {
    await reservation("ASSIGNED");
    await expect(
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "ignore" }),
    ).resolves.toBeUndefined();
  });

  it("an empty queue changes nothing for anyone", async () => {
    await expect(
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "enforce" }),
    ).resolves.toBeUndefined();
  });

  it("the turnover buffer is applied ONCE, not twice", async () => {
    await reservation("ASSIGNED"); // holds the cut [14:00, 14:30)
    // 14:30 leaves zero turnover after a 10-minute buffer shop => refused.
    await expect(
      guard({
        startsAt: at("14:30"),
        endsAt: at("15:00"),
        bufferMin: 10,
        walkInCapacity: "enforce",
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    // 14:40 is exactly one buffer after the cut ends => free. If the span
    // carried the buffer AND the candidate were padded, this would refuse too.
    await expect(
      guard({
        startsAt: at("14:40"),
        endsAt: at("15:10"),
        bufferMin: 10,
        walkInCapacity: "enforce",
      }),
    ).resolves.toBeUndefined();
  });

  it("🔴 releasing, reassigning or terminalizing frees the span on the very next write", async () => {
    const chairB = (await prisma.staff.create({ data: { shopId, name: "Ben" } })).id;
    const free = () =>
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "enforce" });

    // 1. Released back to the line (no chair) - nobody is owed this chair.
    const a = await reservation("ASSIGNED");
    await expect(free()).rejects.toBeInstanceOf(SlotTakenError);
    await prisma.walkInEntry.update({
      where: { id: a.id },
      data: { status: "WAITING", assignedStaffId: null, assignedAt: null },
    });
    await expect(free()).resolves.toBeUndefined();

    // 2. Reassigned to another chair - it holds THAT chair now, not this one.
    await prisma.walkInEntry.update({
      where: { id: a.id },
      data: { status: "ASSIGNED", assignedStaffId: chairB, assignedAt: NOW },
    });
    await expect(free()).resolves.toBeUndefined();

    // 3. Terminal - gone for good.
    await prisma.walkInEntry.update({
      where: { id: a.id },
      data: { status: "ASSIGNED", assignedStaffId: chairA },
    });
    await expect(free()).rejects.toBeInstanceOf(SlotTakenError);
    await prisma.walkInEntry.update({
      where: { id: a.id },
      data: { status: "COMPLETED", completedAt: NOW },
    });
    await expect(free()).resolves.toBeUndefined();
    await prisma.staff.delete({ where: { id: chairB } });
  });

  it("🔴 Walk-In Start excludes its OWN entry - and nobody else's", async () => {
    const first = await reservation("ASSIGNED"); // projected [14:00, 14:30)
    const second = await reservation("ASSIGNED"); // projected [14:30, 15:00)

    // The head of the line starting its own cut is not blocked by itself.
    await expect(
      guard({
        startsAt: at("14:00"),
        endsAt: at("14:30"),
        walkInCapacity: { excludeEntryId: first.id },
      }),
    ).resolves.toBeUndefined();

    // 🔴 But it is still blocked by the person BEHIND it, whose projection did
    // not slide forward when we excluded the head. If the exclusion dropped
    // `first` from the stacking order instead of just the conflict test,
    // `second` would be planned at 14:00 and this would refuse.
    await expect(
      guard({
        startsAt: at("14:30"),
        endsAt: at("15:00"),
        walkInCapacity: { excludeEntryId: first.id },
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);

    // And the second entry cannot start on the first one's span.
    await expect(
      guard({
        startsAt: at("14:00"),
        endsAt: at("14:30"),
        walkInCapacity: { excludeEntryId: second.id },
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("🔴 Walk-In Start still respects the REAL calendar, own entry excluded or not", async () => {
    const e = await reservation("ASSIGNED");
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: chairA,
        serviceId: svc30,
        firstName: "Online",
        startsAt: at("14:00"),
        endsAt: at("14:30"),
        status: "BOOKED",
        priceAtBooking: 40,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    await expect(
      guard({
        startsAt: at("14:00"),
        endsAt: at("14:30"),
        walkInCapacity: { excludeEntryId: e.id },
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    await prisma.appointment.delete({ where: { id: appt.id } });
  });

  it("🔴 a stale grid cannot book time that became reserved after it loaded", async () => {
    // The grid offered 14:00 - it was genuinely free at load.
    expect(await offeredStarts()).toContain(at("14:00").toISOString());
    // Someone walks in and is put on this chair.
    await reservation("ASSIGNED");
    // The customer submits the page they loaded a minute ago.
    await expect(
      guard({ startsAt: at("14:00"), endsAt: at("14:30"), walkInCapacity: "enforce" }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});
