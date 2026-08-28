import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { syncAcuityBlocks } from "../acuity/blocks.js";
import type { AcuityBlock } from "../acuity/types.js";
import { blockReference } from "./acuityMirrorRules.js";
import {
  dispatchCreate,
  reconcileShop,
  releaseAllForShop,
  releaseForAppointment,
} from "./acuityMirror.js";

/**
 * The outbound mirror against a real database.
 *
 * The case this file exists for: ACUITY CREATED THE BLOCK AND CHAIRBACK LOST
 * THE RESPONSE. A timeout, a 502, a reset - the block is live on the barber's
 * calendar and we have no id for it. Cancelling the customer's appointment
 * over that would be a self-inflicted outage, and leaving it would strand a
 * block nothing can ever delete. Recovery by opaque reference is the only way
 * out, and it has to work.
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
  return {
    ...actual,
    getAcuityClientForShop: vi.fn(async () => acuityMock),
  };
});

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const CAL = "cal_77";

/**
 * 🔴 ONE CLOCK, CAPTURED ONCE, AND IT IS INJECTED (issue #302).
 *
 * This file used to run on hardcoded 2026-09-10 fixtures with no injected
 * `now`. reconcileShop asks "which appointments should be holding a block
 * RIGHT NOW", so on 2026-09-10 the seven reconcile tests below would have
 * started deciding nothing: the presence assertions failing loudly, and -
 * far worse - the absence assertions passing for entirely the wrong reason.
 * A green that covers nothing is the failure mode this engine cannot afford.
 *
 * Every fixture instant is now derived from NOW, and NOW is threaded into
 * every reconcileShop call, so these tests exercise the mirror on whatever
 * day they happen to run and cannot rot.
 */
const NOW = new Date();
const START = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 20 * 60 * 1000);
/** A second appointment, the next day - the release-all rollback case. */
const START_2 = new Date(START.getTime() + 24 * 60 * 60 * 1000);
const END_2 = new Date(END.getTime() + 24 * 60 * 60 * 1000);
/** The barber's OWN block: inside the sync window, clear of our span. */
const LUNCH_START = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
const LUNCH_END = new Date(LUNCH_START.getTime() + 60 * 60 * 1000);
/** A window that comfortably brackets everything above. */
const WINDOW_FROM = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const WINDOW_TO = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `mir-${randomToken(6)}@test.local`, passwordHash: "x", name: "M" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Mirror Shop",
      bookingUrl: "https://mir.test",
      webhookSecret: randomToken(),
      bookingMode: "native",
      acuityOutboundMode: "ENFORCE",
    },
  });
  shopId = shop.id;
  // A connection must EXIST for the shop to be eligible (the token itself is
  // never used - the client is mocked).
  const conn = await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_1",
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
    select: { connectedAt: true },
  });
  // 🔴 Derived from `connectedAt`, never from a fresh `new Date()`. A mapping is
  // stale when `mappedAt < connectedAt` (strict, no tolerance) and those two
  // timestamps come from different clocks - Postgres microseconds versus a
  // coarser JS tick - so a mapping written after the connection can still read
  // as a millisecond before it and silently blank the chair.
  const staff = await prisma.staff.create({
    data: {
      shopId,
      name: "Drick",
      acuityCalendarId: CAL,
      acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1_000),
    },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 20, price: 30 },
  });
  serviceId = service.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.externalBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

/** An appointment plus its PENDING outbox row, as the booking tx would write. */
async function seed(over: { startsAt?: Date; endsAt?: Date } = {}) {
  const startsAt = over.startsAt ?? START;
  const endsAt = over.endsAt ?? END;
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Test",
      status: "BOOKED",
      startsAt,
      endsAt,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  const row = await prisma.acuityOutboundBlock.create({
    data: {
      shopId,
      appointmentId: appt.id,
      staffId,
      acuityCalendarId: CAL,
      startsAt,
      endsAt,
      state: "PENDING",
    },
    select: { id: true },
  });
  return { appointmentId: appt.id, outboxId: row.id };
}

const state = async (id: string) =>
  (await prisma.acuityOutboundBlock.findUnique({ where: { id } }))!;

describe("dispatch", () => {
  it("a successful create goes ACTIVE and stores Acuity's id", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    const { outboxId } = await seed();

    expect(await dispatchCreate(outboxId)).toBe("active");
    const row = await state(outboxId);
    expect(row.state).toBe("ACTIVE");
    expect(row.acuityBlockId).toBe("blk_1");
    // The block carries the opaque reference and nothing else.
    const sent = acuityMock.createBlock.mock.calls[0]![0];
    expect(sent.calendarID).toBe(CAL);
    expect(sent.notes).toBe(blockReference(outboxId));
    expect(sent.notes).not.toMatch(/Test|@|\+\d{10}/);
  });

  it("a DEFINITIVE rejection (422) goes FAILED - safe for the caller to compensate", async () => {
    const { AcuityError } = await import("../acuity/client.js");
    acuityMock.createBlock.mockRejectedValue(new AcuityError(422, "bad"));
    const { outboxId } = await seed();

    expect(await dispatchCreate(outboxId)).toBe("failed");
    expect((await state(outboxId)).state).toBe("FAILED");
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "an AMBIGUOUS %i goes UNKNOWN - never FAILED, so nothing is compensated",
    async (status) => {
      const { AcuityError } = await import("../acuity/client.js");
      acuityMock.createBlock.mockRejectedValue(new AcuityError(status, "x"));
      const { outboxId } = await seed();

      expect(await dispatchCreate(outboxId)).toBe("unknown");
      expect((await state(outboxId)).state).toBe("UNKNOWN");
    },
  );

  it("a transport failure with no response at all is AMBIGUOUS", async () => {
    acuityMock.createBlock.mockRejectedValue(new Error("ECONNRESET"));
    const { outboxId } = await seed();
    expect(await dispatchCreate(outboxId)).toBe("unknown");
    expect((await state(outboxId)).state).toBe("UNKNOWN");
  });

  it("re-dispatching an ACTIVE row is a no-op - at most ONE block per appointment", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    const { outboxId } = await seed();
    await dispatchCreate(outboxId);
    expect(await dispatchCreate(outboxId)).toBe("active");
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(1);
  });

  it("CONCURRENT dispatch of one row creates at most one live block", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    const { appointmentId, outboxId } = await seed();
    await Promise.all([dispatchCreate(outboxId), dispatchCreate(outboxId), dispatchCreate(outboxId)]);
    const live = await prisma.acuityOutboundBlock.count({
      where: { appointmentId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
    });
    expect(live).toBe(1);
  });

  it("the database refuses a SECOND live outbox row for one appointment", async () => {
    const { appointmentId } = await seed();
    await expect(
      prisma.acuityOutboundBlock.create({
        data: {
          shopId,
          appointmentId,
          staffId,
          acuityCalendarId: CAL,
          startsAt: START,
          endsAt: END,
          state: "PENDING",
        },
      }),
    ).rejects.toThrow();
  });

  it("does not dispatch when the shop is OFF", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    const { outboxId } = await seed();
    expect(await dispatchCreate(outboxId)).toBe("skipped");
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "ENFORCE" } });
  });
});

describe("ACUITY CREATED IT, CHAIRBACK LOST THE RESPONSE", () => {
  it("the reconciler adopts the real block by reference and never double-creates", async () => {
    const { AcuityError } = await import("../acuity/client.js");
    acuityMock.createBlock.mockRejectedValue(new AcuityError(504, "gateway timeout"));
    const { outboxId } = await seed();

    // The POST timed out - but Acuity DID create it.
    expect(await dispatchCreate(outboxId)).toBe("unknown");

    acuityMock.listBlocks.mockResolvedValue([
      // A decoy at the same time on another calendar, and the barber's own
      // hand-made block: neither may be adopted.
      { id: "decoy", start: START.toISOString(), end: END.toISOString(), calendarID: "cal_other", notes: blockReference(outboxId) },
      { id: "lunch", start: START.toISOString(), end: END.toISOString(), calendarID: CAL, notes: "lunch" },
      { id: "blk_real", start: START.toISOString(), end: END.toISOString(), calendarID: CAL, notes: blockReference(outboxId) },
    ] as AcuityBlock[]);

    const r = await reconcileShop(shopId, NOW);
    expect(r.adopted).toBe(1);
    const row = await state(outboxId);
    expect(row.state).toBe("ACTIVE");
    expect(row.acuityBlockId).toBe("blk_real");
    // Crucially: no second create was ever attempted.
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(1);
  });

  it("when the block genuinely was NOT created, UNKNOWN returns to PENDING for a clean retry", async () => {
    const { AcuityError } = await import("../acuity/client.js");
    acuityMock.createBlock.mockRejectedValue(new AcuityError(503, "down"));
    const { outboxId } = await seed();
    await dispatchCreate(outboxId);

    acuityMock.listBlocks.mockResolvedValue([]);
    await reconcileShop(shopId, NOW);
    expect((await state(outboxId)).state).toBe("PENDING");
  });

  it("adopting also deletes the inbound ExternalBlock echo of our own block", async () => {
    const { AcuityError } = await import("../acuity/client.js");
    acuityMock.createBlock.mockRejectedValue(new AcuityError(502, "x"));
    const { outboxId } = await seed();
    await dispatchCreate(outboxId);

    // The resync already imported our own block as external busy time.
    await prisma.externalBlock.create({
      data: { shopId, externalId: "acuity:blk_real", startsAt: START, endsAt: END },
    });
    acuityMock.listBlocks.mockResolvedValue([
      { id: "blk_real", start: START.toISOString(), end: END.toISOString(), calendarID: CAL, notes: blockReference(outboxId) },
    ] as AcuityBlock[]);

    await reconcileShop(shopId, NOW);
    expect(await prisma.externalBlock.count({ where: { shopId } })).toBe(0);
  });
});

describe("self-echo", () => {
  it("our own block is never imported as an ExternalBlock", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_mine" });
    const { outboxId } = await seed();
    await dispatchCreate(outboxId);

    // Acuity now lists our block alongside a real barber block.
    const res = await syncAcuityBlocks(
      shopId,
      [
        { id: "blk_mine", start: START.toISOString(), end: END.toISOString(), calendarID: CAL, notes: blockReference(outboxId) },
        { id: "blk_lunch", start: LUNCH_START.toISOString(), end: LUNCH_END.toISOString(), calendarID: CAL, notes: "lunch" },
      ] as AcuityBlock[],
      WINDOW_FROM,
      WINDOW_TO,
    );

    expect(res.upserted).toBe(1); // only the barber's own lunch
    const rows = await prisma.externalBlock.findMany({ where: { shopId } });
    expect(rows.map((r) => r.externalId)).toEqual(["acuity:blk_lunch"]);
  });

  it("CANCELLING frees the chair immediately - no echo survives to block it", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_mine" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    const { appointmentId, outboxId } = await seed();
    await dispatchCreate(outboxId);

    // A pre-guard echo exists; the sweep must clear it rather than keep it.
    await prisma.externalBlock.create({
      data: { shopId, externalId: "acuity:blk_mine", startsAt: START, endsAt: END },
    });
    await syncAcuityBlocks(
      shopId,
      [{ id: "blk_mine", start: START.toISOString(), end: END.toISOString(), calendarID: CAL }] as AcuityBlock[],
      WINDOW_FROM,
      WINDOW_TO,
    );
    expect(await prisma.externalBlock.count({ where: { shopId } })).toBe(0);

    await releaseForAppointment(shopId, appointmentId);
    expect(acuityMock.deleteBlock).toHaveBeenCalledWith("blk_mine");
    expect((await state(outboxId)).state).toBe("RELEASED");
  });
});

describe("release", () => {
  it("deletes the block and marks RELEASED", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    const { appointmentId, outboxId } = await seed();
    await dispatchCreate(outboxId);

    await releaseForAppointment(shopId, appointmentId);
    expect((await state(outboxId)).state).toBe("RELEASED");
  });

  it("a block already gone in Acuity (404) counts as released - the goal is 'not blocked there'", async () => {
    const { AcuityError } = await import("../acuity/client.js");
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    acuityMock.deleteBlock.mockRejectedValue(new AcuityError(404, "gone"));
    const { appointmentId, outboxId } = await seed();
    await dispatchCreate(outboxId);

    await releaseForAppointment(shopId, appointmentId);
    const row = await state(outboxId);
    expect(row.state).toBe("RELEASED");
    expect(row.lastError).toBe("already_absent");
  });

  it("a failed delete stays RELEASING and the reconciler retries it", async () => {
    const { AcuityError } = await import("../acuity/client.js");
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    acuityMock.deleteBlock.mockRejectedValueOnce(new AcuityError(500, "down"));
    const { appointmentId, outboxId } = await seed();
    await dispatchCreate(outboxId);

    await releaseForAppointment(shopId, appointmentId);
    expect((await state(outboxId)).state).toBe("RELEASING");

    acuityMock.deleteBlock.mockResolvedValue(undefined);
    const r = await reconcileShop(shopId, NOW);
    expect(r.released).toBe(1);
    expect((await state(outboxId)).state).toBe("RELEASED");
  });

  it("releases even after the shop is switched OFF - never strand a live block", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_1" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    const { appointmentId, outboxId } = await seed();
    await dispatchCreate(outboxId);

    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    await releaseForAppointment(shopId, appointmentId);
    expect((await state(outboxId)).state).toBe("RELEASED");
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "ENFORCE" } });
  });

  it("release-all is a complete rollback for a shop", async () => {
    acuityMock.createBlock.mockResolvedValueOnce({ id: "b1" }).mockResolvedValueOnce({ id: "b2" });
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    const a = await seed();
    const b = await seed({
      startsAt: START_2,
      endsAt: END_2,
    });
    await dispatchCreate(a.outboxId);
    await dispatchCreate(b.outboxId);

    expect(await releaseAllForShop(shopId)).toBe(2);
    expect(acuityMock.deleteBlock).toHaveBeenCalledTimes(2);
    const live = await prisma.acuityOutboundBlock.count({
      where: { shopId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
    });
    expect(live).toBe(0);
  });
});

describe("reconciler hygiene", () => {
  it("a PENDING row whose appointment was cancelled is released, not created", async () => {
    const { appointmentId, outboxId } = await seed();
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: "CANCELED", canceledAt: new Date() },
    });

    const r = await reconcileShop(shopId, NOW);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
    expect(r.released).toBe(1);
    expect((await state(outboxId)).state).toBe("RELEASED");
  });

  it("a PENDING row for an appointment now in the past is released, not created", async () => {
    const { outboxId } = await seed({
      startsAt: new Date("2020-01-01T10:00:00Z"),
      endsAt: new Date("2020-01-01T10:20:00Z"),
    });
    await reconcileShop(shopId, NOW);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
    expect((await state(outboxId)).state).toBe("RELEASED");
  });

  it("finishes a PENDING row the process never dispatched", async () => {
    acuityMock.createBlock.mockResolvedValue({ id: "blk_late" });
    const { outboxId } = await seed();
    const r = await reconcileShop(shopId, NOW);
    expect(r.retried).toBe(1);
    expect((await state(outboxId)).acuityBlockId).toBe("blk_late");
  });
});
