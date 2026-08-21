import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { lockStaffAndAssertSlotFree } from "./bookingWrite.js";
import {
  assertServiceDayHasRoom,
  fullDaysForService,
  limitForWeekday,
  parseDailyLimits,
  ServiceDayFullError,
  shopLocalDayWindow,
} from "./serviceDailyLimit.js";

/**
 * Per-service, per-weekday daily caps.
 *
 * The shop below lives in Los Angeles ON PURPOSE. Every timezone bug this
 * feature can have looks correct on a UTC machine: an 8pm Sunday booking in LA
 * is Monday in UTC, so a naive count puts it on the wrong day and lets a
 * Sunday cap of 3 take a fourth. Tests that only ever use UTC would pass
 * against that bug.
 */

const TZ = "America/Los_Angeles";

let shopId: string;
let staffId: string;
let serviceId: string;
let otherServiceId: string;
let userId: string;

/** A UTC instant for a given LA wall-clock time. LA is UTC-7 in June (PDT). */
function la(day: number, hour: number): Date {
  return new Date(Date.UTC(2026, 5, day, hour + 7));
}

async function book(opts: {
  startsAt: Date;
  status?: "BOOKED" | "PENDING" | "CANCELED" | "COMPLETED";
  serviceId?: string;
  holdExpiresAt?: Date | null;
}): Promise<string> {
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: opts.serviceId ?? serviceId,
      firstName: "Seed",
      status: opts.status ?? "BOOKED",
      startsAt: opts.startsAt,
      endsAt: new Date(opts.startsAt.getTime() + 30 * 60_000),
      holdExpiresAt: opts.holdExpiresAt ?? null,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

/** Set the caps on the service under test. */
async function setLimits(limits: Record<string, number>): Promise<void> {
  await prisma.service.update({ where: { id: serviceId }, data: { dailyLimits: limits } });
}

/** Try to take a place in the day, the way a booking write does. */
function take(startsAt: Date, excludeAppointmentId?: string): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const svc = await tx.service.findUniqueOrThrow({
      where: { id: serviceId },
      select: { dailyLimits: true },
    });
    await assertServiceDayHasRoom(tx, {
      shopId,
      serviceId,
      dailyLimits: svc.dailyLimits,
      timezone: TZ,
      startsAt,
      excludeAppointmentId,
    });
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `cap-${randomToken(6)}@test.chairback`, name: "Cap" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Cap Cuts",
      slug: `cap-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "C" } });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Retwist", durationMin: 30 },
  });
  serviceId = svc.id;
  const other = await prisma.service.create({
    data: { shopId, name: "Fade", durationMin: 30 },
  });
  otherServiceId = other.id;
});

afterEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await setLimits({});
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  // Shop before user: Shop.ownerId -> User has no cascade.
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

/* ------------------------------------------------------------------ */
/* Reading the stored shape                                            */
/* ------------------------------------------------------------------ */

describe("parseDailyLimits", () => {
  it("reads a weekday map", () => {
    expect(parseDailyLimits({ "0": 3, "6": 8 })).toEqual({ 0: 3, 6: 8 });
  });

  it("treats a stored 0 as UNLIMITED, never as 'closed'", () => {
    // This is the whole reason the migration filters `maxPerDay > 0`. The
    // control this replaced used 0 to mean "no cap", so a 0 reaching the
    // engine must never be read as "zero bookings allowed" - that would make
    // the service silently unbookable forever.
    expect(parseDailyLimits({ "0": 0 })).toEqual({});
    expect(limitForWeekday(parseDailyLimits({ "0": 0 }), 0)).toBeNull();
  });

  it("ignores junk rather than trusting a Json column", () => {
    expect(parseDailyLimits(null)).toEqual({});
    expect(parseDailyLimits([1, 2, 3])).toEqual({});
    expect(parseDailyLimits({ "7": 3, x: 2, "1": "4", "2": -1 })).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Timezone boundaries                                                 */
/* ------------------------------------------------------------------ */

describe("which day a booking lands on", () => {
  it("uses the SHOP's day, not UTC's", () => {
    // 8pm Sunday June 7 in LA is 03:00 Monday June 8 in UTC.
    const sundayEvening = la(7, 20);
    expect(sundayEvening.toISOString()).toBe("2026-06-08T03:00:00.000Z");

    const day = shopLocalDayWindow(sundayEvening, TZ);
    expect(day.weekday).toBe(0); // Sunday, as the barber would say
    expect(day.key).toBe("2026-5-7");
  });

  it("counts a late-evening booking against the day the SHOP calls it", async () => {
    // Cap Sundays at 1. Book 8pm Sunday (which is Monday in UTC). A second
    // Sunday booking must be refused - it would not be if the count bucketed
    // the first one into Monday.
    await setLimits({ "0": 1 });
    await book({ startsAt: la(7, 20) });
    await expect(take(la(7, 10))).rejects.toBeInstanceOf(ServiceDayFullError);
  });

  it("does NOT spill over into the next shop-local day", async () => {
    await setLimits({ "0": 1, "1": 1 });
    await book({ startsAt: la(7, 20) }); // Sunday 8pm LA
    // Monday is its own day and still has room, even though the Sunday
    // booking's UTC instant falls on Monday.
    await expect(take(la(8, 10))).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Different limits per weekday, and unlimited days                    */
/* ------------------------------------------------------------------ */

describe("a separate limit for each day", () => {
  it("holds each weekday to its OWN number", async () => {
    // Sunday 1, Monday 3. June 7 2026 is a Sunday.
    await setLimits({ "0": 1, "1": 3 });

    await book({ startsAt: la(7, 10) });
    await expect(take(la(7, 12))).rejects.toBeInstanceOf(ServiceDayFullError);

    await book({ startsAt: la(8, 10) });
    await book({ startsAt: la(8, 12) });
    // Monday's third is still allowed.
    await expect(take(la(8, 14))).resolves.toBeUndefined();
  });

  it("leaves a day with NO entry unlimited", async () => {
    await setLimits({ "0": 1 }); // Sunday only
    for (let i = 0; i < 8; i++) await book({ startsAt: la(9, 8 + i) }); // Tuesday
    await expect(take(la(9, 18))).resolves.toBeUndefined();
  });

  it("does not let one service eat another's allowance", async () => {
    // The cap belongs to the SERVICE. Fades booked all day must not close
    // retwists.
    await setLimits({ "0": 1 });
    await book({ startsAt: la(7, 9), serviceId: otherServiceId });
    await book({ startsAt: la(7, 11), serviceId: otherServiceId });
    await expect(take(la(7, 13))).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* What consumes capacity                                              */
/* ------------------------------------------------------------------ */

describe("which bookings consume a place", () => {
  it("gives the place BACK when a booking is canceled", async () => {
    await setLimits({ "0": 1 });
    const id = await book({ startsAt: la(7, 10) });
    await expect(take(la(7, 12))).rejects.toBeInstanceOf(ServiceDayFullError);

    await prisma.appointment.update({
      where: { id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    // One cancellation must not cost the day permanently.
    await expect(take(la(7, 12))).resolves.toBeUndefined();
  });

  it("counts a PENDING request", async () => {
    // A shop using request-before-booking would otherwise take unlimited
    // requests against a cap of one.
    await setLimits({ "0": 1 });
    await book({ startsAt: la(7, 10), status: "PENDING" });
    await expect(take(la(7, 12))).rejects.toBeInstanceOf(ServiceDayFullError);
  });

  it("counts an ACTIVE hold but not an EXPIRED one", async () => {
    await setLimits({ "0": 1 });
    const future = new Date(Date.now() + 60 * 60_000);
    const id = await book({ startsAt: la(7, 10), status: "PENDING", holdExpiresAt: future });
    await expect(take(la(7, 12))).rejects.toBeInstanceOf(ServiceDayFullError);

    // Let it lapse: the place was released the moment the hold expired, before
    // any sweep gets round to flipping it to CANCELED.
    await prisma.appointment.update({
      where: { id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(take(la(7, 12))).resolves.toBeUndefined();
  });

  it("excludes its own row, so a same-day move is always allowed", async () => {
    await setLimits({ "0": 1 });
    const id = await book({ startsAt: la(7, 10) });
    // Rescheduling 10am -> 2pm on a day capped at 1 must not refuse itself.
    await expect(take(la(7, 14), id)).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* The read path agrees with the write path                            */
/* ------------------------------------------------------------------ */

describe("fullDaysForService", () => {
  it("reports the day full at exactly the moment the write path refuses it", async () => {
    await setLimits({ "0": 2 });
    await book({ startsAt: la(7, 9) });

    const notYet = await fullDaysForService(prisma, {
      shopId,
      serviceId,
      dailyLimits: { "0": 2 },
      timezone: TZ,
      rangeStart: la(7, 0),
      rangeEnd: la(8, 0),
    });
    expect(notYet.has("2026-5-7")).toBe(false);
    await expect(take(la(7, 15))).resolves.toBeUndefined();

    await book({ startsAt: la(7, 11) });
    const nowFull = await fullDaysForService(prisma, {
      shopId,
      serviceId,
      dailyLimits: { "0": 2 },
      timezone: TZ,
      rangeStart: la(7, 0),
      rangeEnd: la(8, 0),
    });
    expect(nowFull.has("2026-5-7")).toBe(true);
    await expect(take(la(7, 15))).rejects.toBeInstanceOf(ServiceDayFullError);
  });
});

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

/**
 * A DETERMINISTIC race, not a hopeful one.
 *
 * Firing two transactions with Promise.all does not reliably interleave them -
 * they are fast enough that the first usually commits before the second reads,
 * so the test passes with the advisory lock REMOVED and proves nothing. (It
 * did. That is why it is written this way.)
 *
 * So the first transaction is held open on a gate: it takes its place in the
 * day and then waits. The second starts while the first is still uncommitted -
 * exactly the window a real double-booking lands in. With the lock, the second
 * blocks until the first commits, re-counts, and correctly loses. Without it,
 * the second reads a stale count of zero and both commit.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take a place in the day and create the row, optionally holding the tx open. */
function bookUnderCap(hour: number, hold?: Promise<void>): Promise<void> {
  return prisma.$transaction(
    async (tx) => {
      const svc = await tx.service.findUniqueOrThrow({
        where: { id: serviceId },
        select: { dailyLimits: true },
      });
      await assertServiceDayHasRoom(tx, {
        shopId,
        serviceId,
        dailyLimits: svc.dailyLimits,
        timezone: TZ,
        startsAt: la(7, hour),
      });
      await tx.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId,
          firstName: `Race${hour}`,
          status: "BOOKED",
          startsAt: la(7, hour),
          endsAt: new Date(la(7, hour).getTime() + 30 * 60_000),
          manageToken: randomToken(),
        },
      });
      if (hold) await hold;
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

describe("two people booking the last place at the same time", () => {
  it("lets exactly ONE through", async () => {
    await setLimits({ "0": 1 });

    const gate = deferred();
    const first = bookUnderCap(10, gate.promise);
    await sleep(250); // first has counted and written, and is still open

    const second = bookUnderCap(14);
    await sleep(250); // second is now blocked on the (service, day) lock

    gate.resolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    // The database agrees: one booking on that day, not two.
    expect(
      await prisma.appointment.count({ where: { shopId, serviceId, status: "BOOKED" } }),
    ).toBe(1);
  });

  it("blocks a second BARBER too - the staff lock alone would not", async () => {
    // Two chairs take two DIFFERENT staff locks, so the existing guard lets
    // both through. This is the case the second lock exists for, and it is how
    // the group cap could overshoot its limit by one.
    await setLimits({ "0": 1 });
    const other = await prisma.staff.create({ data: { shopId, name: "Second chair" } });

    const gate = deferred();
    const first = prisma.$transaction(
      async (tx) => {
        await lockStaffAndAssertSlotFree(tx, {
          staffId,
          shopId,
          startsAt: la(7, 10),
          endsAt: new Date(la(7, 10).getTime() + 30 * 60_000),
          bufferMin: 0,
          serviceDayLimit: { serviceId, timezone: TZ },
        });
        await tx.appointment.create({
          data: {
            shopId,
            staffId,
            serviceId,
            firstName: "ChairA",
            status: "BOOKED",
            startsAt: la(7, 10),
            endsAt: new Date(la(7, 10).getTime() + 30 * 60_000),
            manageToken: randomToken(),
          },
        });
        await gate.promise;
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
    await sleep(250);

    const second = prisma.$transaction(
      async (tx) => {
        await lockStaffAndAssertSlotFree(tx, {
          staffId: other.id, // a DIFFERENT barber: different staff lock
          shopId,
          startsAt: la(7, 14),
          endsAt: new Date(la(7, 14).getTime() + 30 * 60_000),
          bufferMin: 0,
          serviceDayLimit: { serviceId, timezone: TZ },
        });
        await tx.appointment.create({
          data: {
            shopId,
            staffId: other.id,
            serviceId,
            firstName: "ChairB",
            status: "BOOKED",
            startsAt: la(7, 14),
            endsAt: new Date(la(7, 14).getTime() + 30 * 60_000),
            manageToken: randomToken(),
          },
        });
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
    await sleep(250);

    gate.resolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.appointment.count({ where: { shopId, serviceId, status: "BOOKED" } }),
    ).toBe(1);

    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.staff.deleteMany({ where: { id: other.id } });
  });
});
