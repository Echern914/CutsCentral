import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { AcuityError } from "../acuity/client.js";
import { blockReference } from "./acuityMirrorRules.js";
import {
  buildObserveReport,
  completeReschedule,
  dispatchCreateAll,
  reconcileShop,
  recordMirrorIntent,
  releaseForAppointment,
  swapForReschedule,
} from "./acuityMirror.js";

/**
 * ONE CHAIR, SEVERAL ACUITY CALENDARS.
 *
 * The hole these tests close, measured on a real account: a barber whose
 * Acuity page sells him through SIX service-named calendars - "Haircut",
 * "Retwists", "After hours", "LAST MIN" - takes bookings on four of them. A
 * block is calendar-scoped, so the old one-block-per-appointment mirror left
 * the same hour on sale on every calendar it did not name. He was already
 * working around it by hand: the same hour blocked seven times, once per
 * calendar, for every appointment he took.
 *
 * So the promise here is stronger than "a block was written". It is: EVERY
 * calendar this chair occupies is blocked, or the booking is not treated as
 * protected at all. Half-blocked is the state that looks safe and isn't.
 */

const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(),
  listCalendars: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));
vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

let userId: string;
let shopId: string;
let serviceId: string;
/** The multi-calendar barber: one human, three calendars. */
let split: string;
/** An ordinary chair - one calendar, no extras. Nothing about it may change. */
let single: string;

const MAIN = "cal_haircut";
const EXTRA_A = "cal_retwist";
const EXTRA_B = "cal_afterhours";
const SOLO = "cal_solo";

/** Derived from the real clock: the mirror only acts on time still ahead. */
const START = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 30 * 60_000);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `multi-${randomToken(6)}@test.local`, passwordHash: "x", name: "M" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Split Calendar Shop",
      bookingUrl: "https://split.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
      acuityOutboundMode: "ENFORCE",
    },
  });
  shopId = shop.id;
  const conn = await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "acct", accessToken: "enc" },
  });
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
  });
  serviceId = svc.id;
  // mappedAt strictly after connectedAt, or the mapping reads as stale - the
  // two timestamps come from different clocks (see acuityMirror.test.ts).
  const mappedAt = new Date(conn.connectedAt.getTime() + 1_000);
  const a = await prisma.staff.create({
    data: {
      shopId,
      name: "Drick",
      acuityCalendarId: MAIN,
      acuityExtraCalendarIds: [EXTRA_A, EXTRA_B],
      acuityCalendarMappedAt: mappedAt,
    },
  });
  split = a.id;
  const b = await prisma.staff.create({
    data: {
      shopId,
      name: "Solo",
      acuityCalendarId: SOLO,
      acuityCalendarMappedAt: mappedAt,
    },
  });
  single = b.id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId, staffId: split },
      { shopId, serviceId, staffId: single },
    ],
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

async function makeAppt(staffId: string, startsAt = START, endsAt = END) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "T",
      status: "BOOKED",
      startsAt,
      endsAt,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

/** Record the mirror intent the way a booking transaction does. */
async function intent(appointmentId: string, staffId: string, startsAt = START, endsAt = END) {
  return prisma.$transaction((tx) =>
    recordMirrorIntent(tx, {
      shopId,
      now: new Date(),
      appointmentId,
      staffId,
      startsAt,
      endsAt,
      occupancy: {
        status: "BOOKED",
        startsAt,
        endsAt,
        holdExpiresAt: null,
        visitId: null,
      },
    }),
  );
}

const rowsFor = (appointmentId: string) =>
  prisma.acuityOutboundBlock.findMany({
    where: { shopId, appointmentId },
    orderBy: { createdAt: "asc" },
  });

/**
 * State and block id KEYED BY CALENDAR.
 *
 * Rows written inside one transaction share a createdAt to the millisecond, so
 * their row order is not defined - and an assertion that reads by position
 * passes or fails on whatever order Postgres happens to return. What these
 * tests actually mean is "cal_retwist is the one that failed", so they say so.
 */
async function byCalendar(appointmentId: string) {
  const rows = await rowsFor(appointmentId);
  return Object.fromEntries(
    rows.map((r) => [r.acuityCalendarId, { state: r.state, blockId: r.acuityBlockId }]),
  );
}

describe("one booking, one block per calendar", () => {
  it("records a row for EVERY calendar the chair is sold on, primary first", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);

    expect(ids).toHaveLength(3);
    const rows = await rowsFor(a.id);
    expect(rows.map((r) => r.acuityCalendarId).sort()).toEqual(
      [MAIN, EXTRA_A, EXTRA_B].sort(),
    );
    expect(rows.every((r) => r.state === "PENDING")).toBe(true);
    // Each is its own outbox row - one id per calendar, never one shared.
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it("writes one Acuity block per calendar, each with its OWN reference", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockResolvedValueOnce({ id: "blk_a" })
      .mockResolvedValueOnce({ id: "blk_b" });

    expect(await dispatchCreateAll(ids)).toBe("active");

    expect(acuityMock.createBlock).toHaveBeenCalledTimes(3);
    const sent = acuityMock.createBlock.mock.calls.map((c) => c[0]);
    expect(sent.map((s) => s.calendarID)).toEqual([MAIN, EXTRA_A, EXTRA_B]);
    // The reference is what recovers an ambiguous create, so it must identify
    // the ROW - a shared note would make two calendars indistinguishable.
    expect(sent.map((s) => s.notes)).toEqual(ids.map((id) => blockReference(id)));
    expect(await byCalendar(a.id)).toEqual({
      [MAIN]: { state: "ACTIVE", blockId: "blk_main" },
      [EXTRA_A]: { state: "ACTIVE", blockId: "blk_a" },
      [EXTRA_B]: { state: "ACTIVE", blockId: "blk_b" },
    });
  });

  it("a chair with no extras still records exactly ONE row - nothing changed for normal shops", async () => {
    const a = await makeAppt(single);
    const ids = await intent(a.id, single);

    expect(ids).toHaveLength(1);
    const rows = await rowsFor(a.id);
    expect(rows.map((r) => r.acuityCalendarId)).toEqual([SOLO]);
  });

  it("the OBSERVE rehearsal names every calendar a booking would block", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { acuityOutboundMode: "OBSERVE" },
    });
    const a = await makeAppt(split);
    try {
      const report = await buildObserveReport(shopId, new Date());
      const row = report.wouldCreate.find((w) => w.appointmentId === a.id)!;
      expect(row.calendarIds).toEqual([MAIN, EXTRA_A, EXTRA_B]);
      expect(row.blocked).toBe(false);
    } finally {
      await prisma.shop.update({
        where: { id: shopId },
        data: { acuityOutboundMode: "ENFORCE" },
      });
    }
  });
});

describe("partial protection is NOT protection", () => {
  it("one calendar refusing definitively fails the whole dispatch", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockRejectedValueOnce(new AcuityError(422, "nope"))
      .mockResolvedValueOnce({ id: "blk_b" });

    // THE POINT: two blocks landed, and the answer is still "failed". The
    // customer's hour is still on sale on cal_retwist, so a fail-closed caller
    // must not be told this booking is protected.
    expect(await dispatchCreateAll(ids)).toBe("failed");

    const rows = await byCalendar(a.id);
    expect(rows[MAIN]!.state).toBe("ACTIVE");
    expect(rows[EXTRA_A]!.state).toBe("FAILED");
    expect(rows[EXTRA_B]!.state).toBe("ACTIVE");
  });

  it("every calendar is still attempted after one fails", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockRejectedValueOnce(new AcuityError(422, "nope"))
      .mockResolvedValueOnce({ id: "blk_a" })
      .mockResolvedValueOnce({ id: "blk_b" });

    await dispatchCreateAll(ids);

    // Stopping at the first failure would leave rows PENDING for the
    // reconciler to finish - work we can simply do now.
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(3);
    expect((await rowsFor(a.id)).some((r) => r.state === "PENDING")).toBe(false);
  });

  it("an ambiguous calendar makes the dispatch unknown - never failed", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockRejectedValueOnce(new AcuityError(504, "timeout"))
      .mockResolvedValueOnce({ id: "blk_b" });

    // Compensating here would cancel a real appointment over a lost response
    // AND strand a block nothing points at.
    expect(await dispatchCreateAll(ids)).toBe("unknown");
    const rows = await byCalendar(a.id);
    expect(rows[MAIN]!.state).toBe("ACTIVE");
    expect(rows[EXTRA_A]!.state).toBe("UNKNOWN");
    expect(rows[EXTRA_B]!.state).toBe("ACTIVE");
  });

  it("a definitive refusal outranks an ambiguous one", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockRejectedValueOnce(new AcuityError(504, "timeout"))
      .mockRejectedValueOnce(new AcuityError(422, "nope"))
      .mockResolvedValueOnce({ id: "blk_b" });

    // "failed" is the answer that makes the caller undo the booking; an
    // ambiguous sibling must not soften a proven hole into a wait-and-see.
    expect(await dispatchCreateAll(ids)).toBe("failed");
  });
});

describe("release frees every calendar it took", () => {
  it("cancelling deletes all three blocks", async () => {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockResolvedValueOnce({ id: "blk_a" })
      .mockResolvedValueOnce({ id: "blk_b" });
    await dispatchCreateAll(ids);
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    await releaseForAppointment(shopId, a.id);

    expect(acuityMock.deleteBlock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "blk_a",
      "blk_b",
      "blk_main",
    ]);
    expect((await rowsFor(a.id)).every((r) => r.state === "RELEASED")).toBe(true);
  });

  it("a half-dispatched booking still releases the blocks that DID land", async () => {
    // The customer path compensates on "failed" - if release skipped the rows
    // that succeeded, two of this barber's calendars would stay blocked for an
    // appointment that no longer exists, with nothing left pointing at them.
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main" })
      .mockRejectedValueOnce(new AcuityError(422, "nope"))
      .mockResolvedValueOnce({ id: "blk_b" });
    await dispatchCreateAll(ids);
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    await releaseForAppointment(shopId, a.id);

    expect(acuityMock.deleteBlock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "blk_b",
      "blk_main",
    ]);
  });
});

describe("the live-per-calendar unique index", () => {
  it("refuses a SECOND live row for the same appointment on the same calendar", async () => {
    const a = await makeAppt(split);
    await intent(a.id, split);
    // A re-dispatch, a retried backfill or a concurrent writer must never mint
    // a second block for one (appointment, calendar).
    await expect(
      prisma.acuityOutboundBlock.create({
        data: {
          shopId,
          appointmentId: a.id,
          staffId: split,
          acuityCalendarId: MAIN,
          startsAt: START,
          endsAt: END,
          state: "PENDING",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("ALLOWS live rows for the same appointment on different calendars", async () => {
    // The whole change in one assertion: the old index made this impossible,
    // which is why one booking could only ever block one calendar.
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    expect(ids).toHaveLength(3);
    expect(
      await prisma.acuityOutboundBlock.count({
        where: { shopId, appointmentId: a.id, state: "PENDING" },
      }),
    ).toBe(3);
  });
});

describe("reschedule resolves ONE CALENDAR AT A TIME", () => {
  /** Three live blocks, then a move that retires all three. */
  async function stageSwap() {
    const a = await makeAppt(split);
    const ids = await intent(a.id, split);
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main_old" })
      .mockResolvedValueOnce({ id: "blk_a_old" })
      .mockResolvedValueOnce({ id: "blk_b_old" });
    await dispatchCreateAll(ids);
    acuityMock.createBlock.mockReset();
    acuityMock.deleteBlock.mockReset();

    const newStart = new Date(START.getTime() + 60 * 60_000);
    const newEnd = new Date(newStart.getTime() + 30 * 60_000);
    const newIds = await prisma.$transaction((tx) =>
      swapForReschedule(tx, {
        shopId,
        now: new Date(),
        appointmentId: a.id,
        staffId: split,
        startsAt: newStart,
        endsAt: newEnd,
        occupancy: {
          status: "BOOKED",
          startsAt: newStart,
          endsAt: newEnd,
          holdExpiresAt: null,
          visitId: null,
        },
      }),
    );
    return { apptId: a.id, newIds };
  }

  it("retires the old row on every calendar and records a replacement for each", async () => {
    const { apptId, newIds } = await stageSwap();
    expect(newIds).toHaveLength(3);
    const releasing = await prisma.acuityOutboundBlock.findMany({
      where: { shopId, appointmentId: apptId, state: "RELEASING" },
    });
    expect(releasing.map((r) => r.acuityCalendarId).sort()).toEqual(
      [MAIN, EXTRA_A, EXTRA_B].sort(),
    );
  });

  it("every old block is released once its replacement is live", async () => {
    const { apptId, newIds } = await stageSwap();
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main_new" })
      .mockResolvedValueOnce({ id: "blk_a_new" })
      .mockResolvedValueOnce({ id: "blk_b_new" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    expect(await completeReschedule(shopId, apptId, newIds)).toBe("active");

    expect(acuityMock.deleteBlock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "blk_a_old",
      "blk_b_old",
      "blk_main_old",
    ]);
  });

  it("the calendar whose replacement FAILED keeps its old block; the others hand over", async () => {
    const { apptId, newIds } = await stageSwap();
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main_new" })
      .mockRejectedValueOnce(new AcuityError(422, "nope"))
      .mockResolvedValueOnce({ id: "blk_b_new" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);

    expect(await completeReschedule(shopId, apptId, newIds)).toBe("failed");

    const rows = await rowsFor(apptId);
    const byBlock = (id: string) => rows.find((r) => r.acuityBlockId === id)!;
    // cal_retwist never got its new block, so the OLD one is all that keeps
    // that hour off the market - it goes back to ACTIVE, which is the truth.
    expect(byBlock("blk_a_old").state).toBe("ACTIVE");
    expect(acuityMock.deleteBlock.mock.calls.map((c) => c[0])).not.toContain("blk_a_old");
    // The two calendars that DID hand over free their old time, because on
    // those calendars the new block is confirmed live.
    expect(byBlock("blk_main_old").state).toBe("RELEASED");
    expect(byBlock("blk_b_old").state).toBe("RELEASED");
  });

  it("the reconciler frees a calendar whose replacement landed, and holds the one still in flight", async () => {
    const { apptId, newIds } = await stageSwap();
    acuityMock.createBlock
      .mockResolvedValueOnce({ id: "blk_main_new" })
      .mockRejectedValueOnce(new AcuityError(504, "timeout"))
      .mockResolvedValueOnce({ id: "blk_b_new" });
    // Ambiguous anywhere ⇒ every old row is retained for the reconciler.
    expect(await completeReschedule(shopId, apptId, newIds)).toBe("unknown");
    expect(acuityMock.deleteBlock).not.toHaveBeenCalled();

    acuityMock.deleteBlock.mockResolvedValue(undefined);
    acuityMock.listBlocks.mockResolvedValue([]); // the ambiguous one truly is absent

    await reconcileShop(shopId);

    // 🔴 THE PER-CALENDAR QUESTION. Asking only "does this appointment have a
    // replacement in flight" would hold cal_haircut and cal_afterhours hostage
    // to cal_retwist's unresolved row - two calendars blocked at a time the
    // customer no longer has.
    const deleted = acuityMock.deleteBlock.mock.calls.map((c) => c[0]);
    expect(deleted.sort()).toEqual(["blk_b_old", "blk_main_old"]);
    const rows = await rowsFor(apptId);
    expect(rows.find((r) => r.acuityBlockId === "blk_a_old")!.state).toBe("RELEASING");
  });
});
