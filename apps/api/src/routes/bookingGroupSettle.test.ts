import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { shopDayAhead } from "../testing/shopDay.js";

/**
 * FINISHING A PARTY WHOSE ACUITY MIRROR CAME BACK AMBIGUOUS.
 *
 * 🔴 THE FAILURE THIS FILE EXISTS FOR. An UNKNOWN create is one we never got
 * an answer to: the block may or may not exist in Acuity. Two things follow,
 * and the first version of this feature got both wrong.
 *
 *  1. UNKNOWN OUTRANKS FAILED. dispatchCreateAll collapses several answers
 *     into one and lets `failed` win. For one appointment that is right; for a
 *     party it means compensating on the strength of a member that definitely
 *     failed while another member may be holding a REAL block - which is then
 *     orphaned on the barber's calendar with nothing pointing at it.
 *  2. A RELEASE MUST NOT DESTROY THE UNKNOWN. releaseForAppointment bulk-set
 *     every row to RELEASING before releaseRow could see it, so releaseRow's
 *     own "leave an UNKNOWN for the reconciler" guard could never fire.
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

/** The confirmation is the thing we count; never let a real one go out. */
const notifyMock = vi.hoisted(() => ({ notifyAppointmentConfirmation: vi.fn() }));
vi.mock("../services/appointmentNotify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/appointmentNotify.js")>();
  return { ...actual, notifyAppointmentConfirmation: notifyMock.notifyAppointmentConfirmation };
});

const { createApp } = await import("../app.js");
const { AcuityError } = await import("../acuity/client.js");
const { reconcileShop } = await import("../engines/acuityMirror.js");
const { settleAmbiguousGroups } = await import("../engines/appointmentGroupSettle.js");
const { blockReference } = await import("../engines/acuityMirrorRules.js");
// 🔴 Resolve the mocked module ONCE here: a module reached through a dynamic
// import during a test can otherwise hand back a different copy than the one
// carrying the spy, and the count silently stays at zero.
await import("../services/appointmentNotify.js");

const app = createApp();
const TZ = "America/New_York";
const DAY = shopDayAhead(7, TZ, { avoidDstChange: true });
const at = (min: number) => zonedWallTimeToUtc(DAY.y, DAY.m0, DAY.d, min, TZ);
const TWO_PM = at(14 * 60);

let userId: string;
let slug: string;
let shopId: string;
let staffId: string;
let cutId: string;
let kidsId: string;
let beardId: string;

/** A second tenant, to prove a sweep never reaches across shops. */
let otherUserId: string;
let otherShopId: string;

const booker = { firstName: "Eric", phone: "+12015550134", email: "eric@test.chairback" };

async function makeShop(prefix: string, calendarId: string | null) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  const theSlug = `${prefix}-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Settle Cuts",
      slug: theSlug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 2,
      bookingMaxDays: 60,
      acuityOutboundMode: "ENFORCE",
    },
    select: { id: true },
  });
  await prisma.acuityConnection.create({
    data: { shopId: shop.id, acuityAccountId: "acct", accessToken: "enc" },
  });
  const staff = await prisma.staff.create({
    data: { shopId: shop.id, name: "Sam", acuityCalendarId: calendarId },
    select: { id: true },
  });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId: shop.id,
      staffId: staff.id,
      weekday,
      startMin: 10 * 60,
      endMin: 20 * 60,
    })),
  });
  return { userId: user.id, slug: theSlug, shopId: shop.id, staffId: staff.id };
}

async function makeService(shop: string, staff: string, name: string, dur: number) {
  const svc = await prisma.service.create({
    data: { shopId: shop, name, durationMin: dur, price: 30 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({ data: { shopId: shop, serviceId: svc.id, staffId: staff } });
  return svc.id;
}

beforeAll(async () => {
  const main = await makeShop("stl", "cal-1");
  userId = main.userId;
  slug = main.slug;
  shopId = main.shopId;
  staffId = main.staffId;
  cutId = await makeService(shopId, staffId, "Haircut", 30);
  kidsId = await makeService(shopId, staffId, "Kids cut", 20);
  beardId = await makeService(shopId, staffId, "Beard trim", 15);

  const other = await makeShop("oth", "cal-9");
  otherUserId = other.userId;
  otherShopId = other.shopId;
});

beforeEach(async () => {
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
  acuityMock.createBlock.mockReset();
  acuityMock.deleteBlock.mockReset();
  acuityMock.listBlocks.mockReset();
  acuityMock.deleteBlock.mockResolvedValue(undefined);
  acuityMock.listBlocks.mockResolvedValue([]);
  notifyMock.notifyAppointmentConfirmation.mockReset();
});

afterAll(async () => {
  for (const id of [userId, otherUserId]) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

const three = [
  { firstName: "Eric", serviceId: () => cutId },
  { firstName: "Brother", serviceId: () => kidsId },
  { firstName: "Dad", serviceId: () => beardId },
];

const createGroup = (n = 3) =>
  request(app)
    .post(`/api/book/${slug}/group`)
    .send({
      staffId,
      startsAt: TWO_PM.toISOString(),
      attendees: three.slice(0, n).map((a) => ({ firstName: a.firstName, serviceId: a.serviceId() })),
      ...booker,
    });

const rowsOf = () =>
  prisma.acuityOutboundBlock.findMany({
    where: { shopId },
    orderBy: { startsAt: "asc" },
    select: { id: true, state: true, acuityBlockId: true, releaseRequestedAt: true, startsAt: true, endsAt: true, acuityCalendarId: true },
  });

const booked = () =>
  prisma.appointment.count({ where: { shopId, status: "BOOKED" } });

const theGroup = () => prisma.appointmentGroup.findFirst({ where: { shopId } });

/**
 * createBlock answers, in call order. The LAST answer repeats, so a party of
 * three can be described with two entries when the tail is uniform.
 */
type Answer = "ok" | 422 | 503;
function answerWith(...answers: [Answer, ...Answer[]]) {
  let i = 0;
  acuityMock.createBlock.mockImplementation(async () => {
    // Indexing is bounded by construction (answers is non-empty and the index
    // is clamped), but the tuple type is what makes that true for the compiler
    // rather than only for the reader - `tsc` runs over .test.ts on the
    // Railway build, where vitest's happy silence counts for nothing.
    const a: Answer = answers[Math.min(i, answers.length - 1)] ?? answers[0];
    i += 1;
    if (a === "ok") return { id: `blk-${i}` };
    throw new AcuityError(a, a === 422 ? "declined" : "down");
  });
}

describe("🔴 uncertainty anywhere means nothing is definitive", () => {
  it("ACTIVE + FAILED + UNKNOWN answers 202 and compensates NOTHING", async () => {
    // The party that used to be destroyed. `failed` would win the collapse,
    // the group would be compensated, and the UNKNOWN member's block - which
    // may really exist - would be orphaned on the barber's calendar.
    answerWith("ok", 422, 503);
    const res = await createGroup(3);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("processing");

    // Nobody cancelled. The chairs are still held while we find out.
    expect(await booked()).toBe(3);
    const group = await theGroup();
    expect(group!.status).toBe("ACTIVE");
    expect(group!.mirrorPendingSince).not.toBeNull();

    // And no confirmation: we cannot promise a time we cannot prove is held.
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("the ambiguity is recorded DURABLY, not in memory", async () => {
    // A process restart between the 202 and the settlement must not lose a
    // party that is holding real chairs.
    answerWith("ok", 503);
    await createGroup(2);
    const group = await theGroup();
    expect(group!.mirrorPendingSince).toBeInstanceOf(Date);
    // Everything needed to finish the job is readable from the database alone.
    const rows = await rowsOf();
    expect(rows.some((r) => r.state === "UNKNOWN")).toBe(true);
  });
});

describe("🔴 an UNKNOWN block that really exists is found, not orphaned", () => {
  it("reconciliation adopts it by reference", async () => {
    answerWith("ok", 503);
    await createGroup(2);
    const before = await rowsOf();
    const unknown = before.find((r) => r.state === "UNKNOWN")!;
    expect(unknown.acuityBlockId).toBeNull();

    // It DID land in Acuity - we just never heard. The reconciler finds it by
    // the reference note we wrote into it.
    acuityMock.listBlocks.mockResolvedValue([
      {
        id: "blk-recovered",
        notes: blockReference(unknown.id),
        calendarID: unknown.acuityCalendarId,
        start: unknown.startsAt.toISOString(),
        end: unknown.endsAt.toISOString(),
      },
    ]);
    await reconcileShop(shopId);

    const after = (await rowsOf()).find((r) => r.id === unknown.id)!;
    expect(after.state).toBe("ACTIVE");
    // 🔴 The id is recorded, which is what makes it deletable later. Without
    // this the block is unreachable forever.
    expect(after.acuityBlockId).toBe("blk-recovered");
  });
});

describe("🔴 UNKNOWN that settles ACTIVE sends exactly ONE confirmation", () => {
  async function settleHappy() {
    answerWith("ok", 503);
    await createGroup(2);
    const unknown = (await rowsOf()).find((r) => r.state === "UNKNOWN")!;
    acuityMock.listBlocks.mockResolvedValue([
      {
        id: "blk-recovered",
        notes: blockReference(unknown.id),
        calendarID: unknown.acuityCalendarId,
        start: unknown.startsAt.toISOString(),
        end: unknown.endsAt.toISOString(),
      },
    ]);
    await reconcileShop(shopId);
    return settleAmbiguousGroups(shopId);
  }

  it("confirms the party once every block is ACTIVE", async () => {
    const r = await settleHappy();
    expect(r.confirmed).toBe(1);
    expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
    // Still booked, and no longer pending.
    expect(await booked()).toBe(2);
    expect((await theGroup())!.mirrorPendingSince).toBeNull();
  });

  it("🔴 ONE confirmation, not one per member", async () => {
    await settleHappy();
    expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
  });

  it("🔴 REPLAYING the sweep does not send a second one", async () => {
    // 🔴 THE FIRST VERSION OF THIS TEST WAS THEATER. It settled, then called
    // the sweep again - but the sweep had already cleared mirrorPendingSince,
    // so the party was no longer in its query and the claim was never reached.
    // It passed with the compare-and-set REMOVED, which is the definition of
    // proving nothing.
    //
    // The real scenario the CAS defends is a crash BETWEEN sending and
    // clearing the marker: the next sweep finds the party still pending and
    // would confirm it a second time. So put it back into exactly that state.
    await settleHappy();
    notifyMock.notifyAppointmentConfirmation.mockClear();
    const group = await theGroup();
    expect(group!.confirmationSentAt).not.toBeNull();

    await prisma.appointmentGroup.update({
      where: { id: group!.id },
      data: { mirrorPendingSince: new Date() },
    });
    await settleAmbiguousGroups(shopId);
    await settleAmbiguousGroups(shopId);
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("🔴 claiming twice in a row yields ONE send, even back to back", async () => {
    // The narrowest statement of the guard, with no sweep around it: two
    // callers, one confirmation. This is what a retry racing the response, or
    // two replicas sweeping together, actually looks like.
    await settleHappy();
    notifyMock.notifyAppointmentConfirmation.mockClear();
    const group = await theGroup();
    const { sendGroupConfirmationOnce } = await import(
      "../engines/appointmentGroupSettle.js"
    );
    const a = await sendGroupConfirmationOnce(shopId, group!.id);
    const b = await sendGroupConfirmationOnce(shopId, group!.id);
    expect([a, b]).toEqual([false, false]); // already claimed by settleHappy
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("🔴 a party that has NEVER been confirmed is claimed exactly once", async () => {
    // And the other direction, so the test above cannot pass merely because
    // the marker was already set: a fresh party, two concurrent claimants,
    // exactly one winner.
    answerWith("ok");
    await createGroup(2);
    const group = await theGroup();
    await prisma.appointmentGroup.update({
      where: { id: group!.id },
      data: { confirmationSentAt: null },
    });
    notifyMock.notifyAppointmentConfirmation.mockClear();

    const { sendGroupConfirmationOnce } = await import(
      "../engines/appointmentGroupSettle.js"
    );
    const results = await Promise.all([
      sendGroupConfirmationOnce(shopId, group!.id),
      sendGroupConfirmationOnce(shopId, group!.id),
      sendGroupConfirmationOnce(shopId, group!.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
  });

  it("a party still in flight is left alone, not confirmed", async () => {
    answerWith("ok", 503);
    await createGroup(2);
    // No reconcile: the UNKNOWN is still unresolved.
    const r = await settleAmbiguousGroups(shopId);
    expect(r.pending).toBe(1);
    expect(r.confirmed).toBe(0);
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });
});

describe("🔴 UNKNOWN that proves absent compensates the WHOLE party", () => {
  it("cancels everybody and leaves no partial family booking", async () => {
    answerWith("ok", 422, 503);
    await createGroup(3);
    expect(await booked()).toBe(3);

    // The unknown one was never created - Acuity has nothing matching.
    acuityMock.listBlocks.mockResolvedValue([]);
    await reconcileShop(shopId);
    // The UNKNOWN is now PENDING (safe to retry) - still in flight.
    let r = await settleAmbiguousGroups(shopId);
    expect(r.pending).toBe(1);

    // The retry definitively fails too.
    answerWith(422);
    await reconcileShop(shopId);
    r = await settleAmbiguousGroups(shopId);

    expect(r.compensated).toBe(1);
    // 🔴 NO PARTIAL FAMILY BOOKING. Not one chair survives.
    expect(await booked()).toBe(0);
    const group = await theGroup();
    expect(group!.status).toBe("CANCELED");
    expect(group!.mirrorPendingSince).toBeNull();
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("🔴 compensation DELETES every block that really landed", async () => {
    // The member whose create succeeded has a real block on the barber's
    // calendar. Cancelling the appointments without deleting it would leave
    // the chair unsellable in Acuity with nothing pointing at it.
    answerWith("ok", 422);
    await createGroup(2);

    // The route compensates immediately here: no unknown, one definitive fail.
    expect(await booked()).toBe(0);
    // The first member's create SUCCEEDED and returned blk-1. That block is
    // real, and compensation has to delete it - asserted on the call, because
    // by now the row itself has correctly moved on to RELEASED.
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk-1");
    const rows = await rowsOf();
    expect(rows.every((r) => r.state === "RELEASED" || r.state === "FAILED")).toBe(true);
  });
});

describe("🔴 a release must not destroy an UNKNOWN", () => {
  it("records the intent and leaves the state, so the block can still be found", async () => {
    answerWith("ok", 503);
    await createGroup(2);
    const unknownBefore = (await rowsOf()).find((r) => r.state === "UNKNOWN")!;

    // Compensate while the ambiguity is unresolved - a cancel, or a failed
    // sibling. This is the moment the old code destroyed the evidence.
    const { compensateGroup } = await import("../engines/appointmentGroupSettle.js");
    await compensateGroup(shopId, (await theGroup())!.id);

    const after = (await rowsOf()).find((r) => r.id === unknownBefore.id)!;
    // 🔴 STILL UNKNOWN, and now carrying the release intent. Marked RELEASED
    // here - which is what used to happen - the block would be unreachable.
    expect(after.state).toBe("UNKNOWN");
    expect(after.releaseRequestedAt).not.toBeNull();

    // And when the reconciler finds the block, it is DELETED rather than left.
    acuityMock.listBlocks.mockResolvedValue([
      {
        id: "blk-late",
        notes: blockReference(unknownBefore.id),
        calendarID: unknownBefore.acuityCalendarId,
        start: unknownBefore.startsAt.toISOString(),
        end: unknownBefore.endsAt.toISOString(),
      },
    ]);
    await reconcileShop(shopId);

    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk-late");
    const settled = (await rowsOf()).find((r) => r.id === unknownBefore.id)!;
    expect(settled.state).toBe("RELEASED");
  });

  it("proving absence is the only way an UNKNOWN becomes RELEASED with no id", async () => {
    answerWith("ok", 503);
    await createGroup(2);
    const unknownBefore = (await rowsOf()).find((r) => r.state === "UNKNOWN")!;
    const { compensateGroup } = await import("../engines/appointmentGroupSettle.js");
    await compensateGroup(shopId, (await theGroup())!.id);

    acuityMock.listBlocks.mockResolvedValue([]); // genuinely not there
    await reconcileShop(shopId);

    const settled = (await rowsOf()).find((r) => r.id === unknownBefore.id)!;
    // 🔴 RELEASED only once absence was PROVEN, and still carrying no block id
    // because there was never a block. That is the honest terminal state; the
    // old code reached it by assumption instead, which is how a real block
    // would have been orphaned.
    expect(settled.state).toBe("RELEASED");
    expect(settled.acuityBlockId).toBeNull();
  });
});

describe("the ordinary paths still behave", () => {
  it("all ACTIVE confirms once, immediately, with no pending marker", async () => {
    answerWith("ok");
    const res = await createGroup(2);
    expect(res.status).toBe(201);
    expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect((await theGroup())!.mirrorPendingSince).toBeNull();
    expect((await theGroup())!.confirmationSentAt).not.toBeNull();
  });

  it("mirroring OFF books the party and makes zero outbound calls", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    try {
      const res = await createGroup(2);
      expect(res.status).toBe(201);
      expect(await booked()).toBe(2);
      expect(acuityMock.createBlock).not.toHaveBeenCalled();
      expect(notifyMock.notifyAppointmentConfirmation).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.shop.update({
        where: { id: shopId },
        data: { acuityOutboundMode: "ENFORCE" },
      });
    }
  });
});

describe("🔴 tenant isolation", () => {
  it("a sweep for another shop never touches this shop's party", async () => {
    answerWith("ok", 503);
    await createGroup(2);
    const before = await theGroup();
    expect(before!.mirrorPendingSince).not.toBeNull();

    const r = await settleAmbiguousGroups(otherShopId);
    expect(r).toEqual({ pending: 0, confirmed: 0, compensated: 0 });

    const after = await theGroup();
    expect(after!.mirrorPendingSince).toEqual(before!.mirrorPendingSince);
    expect(after!.status).toBe("ACTIVE");
    expect(await booked()).toBe(2);
    expect(notifyMock.notifyAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("compensating under the wrong shop id changes nothing", async () => {
    answerWith("ok");
    await createGroup(2);
    const group = await theGroup();
    const { compensateGroup } = await import("../engines/appointmentGroupSettle.js");
    await compensateGroup(otherShopId, group!.id);
    expect(await booked()).toBe(2);
    expect((await theGroup())!.status).toBe("ACTIVE");
  });
});
