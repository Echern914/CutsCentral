import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { SquareError } from "../square/client.js";
import { runAcuityOutboundReconcile } from "./acuityMirror.js";
import {
  dispatchSquareCreate,
  recordSquareIntent,
  reconcileSquareShop,
  releaseSquareForAppointment,
  rescheduleSquareForAppointment,
  SquareMirrorNotConfiguredError,
} from "./squareMirror.js";

/**
 * THE OUTBOUND ENGINE, against a real database and a mocked Square account.
 *
 * What this file is defending. Square has no blocked time, so every mirror is a
 * REAL booking on a real seller's calendar with a real customer attached. The
 * ways that can do harm are specific:
 *
 *   - writing over somebody who is already in that chair
 *   - creating two bookings for one appointment
 *   - calling a PENDING booking "protected"
 *   - cancelling a customer's appointment because we lost a response
 *   - freeing the old time before the new one is confirmed
 *   - leaving a booking behind when the feature is switched off
 */

let seq = 0;
const squareMock = vi.hoisted(() => ({
  getBooking: vi.fn(),
  listBookings: vi.fn(),
  getCustomer: vi.fn(),
  listLocations: vi.fn(async () => [{ id: "L1", name: "Main", status: "ACTIVE" }]),
  getBusinessBookingProfile: vi.fn(async () => ({
    booking_enabled: true,
    support_seller_level_writes: true,
  })),
  listTeamMemberBookingProfiles: vi.fn(async () => [
    { team_member_id: "TM1", display_name: "Dre", is_bookable: true },
  ]),
  listServiceCatalogItems: vi.fn(async () => []),
  getTokenStatus: vi.fn(async () => ({ scopes: [] })),
  ensureCustomer: vi.fn(async () => ({ id: "CUST_1" })),
  searchAvailability: vi.fn(async () => []),
  createBooking: vi.fn(),
  updateBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock("../square/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../square/client.js")>();
  return { ...actual, getSquareClientForShop: vi.fn(async () => squareMock) };
});

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let otherShopId: string;

const soon = (min: number) => new Date(Date.now() + min * 60_000);

function stubCreateAccepted() {
  squareMock.createBooking.mockImplementation(async (input: { startAt: string }) => ({
    id: `BK_${(seq += 1)}`,
    version: 1,
    status: "ACCEPTED",
    start_at: input.startAt,
    appointment_segments: [],
  }));
}

async function makeAppointment(over: { shop?: string; startsAt?: Date } = {}) {
  const startsAt = over.startsAt ?? soon(90);
  return prisma.appointment.create({
    data: {
      shopId: over.shop ?? shopId,
      staffId,
      serviceId,
      firstName: "Marcus",
      lastName: "Holloway",
      phone: "+15555550123",
      email: "marcus@example.test",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

/** Record an intent the way a booking transaction does. */
async function intentFor(apptId: string, startsAt: Date, endsAt: Date) {
  return prisma.$transaction((tx) =>
    recordSquareIntent(tx, {
      shopId,
      appointmentId: apptId,
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

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqm-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Square Mirror Shop",
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      squareOutboundMode: "ENFORCE",
    },
  });
  shopId = shop.id;
  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: `M_${randomToken(6)}`,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
      connectionGeneration: 1,
      outboundLocationId: "L1",
      outboundLocationGeneration: 1,
      outboundLocationSelectedAt: new Date(),
    },
  });
  const service = await prisma.service.create({
    data: {
      shopId,
      name: "Cut",
      durationMin: 30,
      price: 40,
      squareServiceVariationId: "VAR1",
      squareServiceVariationVersion: "100",
      squareServiceVariationMappedGeneration: 1,
      squareServiceVariationMappedAt: new Date(),
    },
  });
  serviceId = service.id;
  const staff = await prisma.staff.create({
    data: {
      shopId,
      name: "Dre",
      squareTeamMemberId: "TM1",
      squareTeamMemberMappedGeneration: 1,
      squareTeamMemberMappedAt: new Date(),
    },
  });
  staffId = staff.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });

  const other = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Other Square Shop",
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
  });
  otherShopId = other.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  squareMock.listBookings.mockResolvedValue({ bookings: [], cursor: null });
  squareMock.searchAvailability.mockResolvedValue([]);
  squareMock.ensureCustomer.mockResolvedValue({ id: "CUST_1" });
  stubCreateAccepted();
  await prisma.shop.update({
    where: { id: shopId },
    data: { squareOutboundMode: "ENFORCE", bookingMode: "native" },
  });
});

afterEach(async () => {
  // 🔴 Guarded: Prisma reads `{ shopId: undefined }` as NO FILTER, not "no
  // match", so an unguarded cleanup after a failed beforeAll would delete every
  // row in the shared test database and surface as unrelated files failing.
  for (const id of [shopId, otherShopId].filter(Boolean)) {
    await prisma.squareOutboundBooking.deleteMany({ where: { shopId: id } });
    await prisma.appointment.deleteMany({ where: { shopId: id } });
  }
});

afterAll(async () => {
  const ids = [shopId, otherShopId].filter(Boolean);
  if (ids.length) {
    await prisma.serviceStaff.deleteMany({ where: { shopId: { in: ids } } });
    await prisma.staff.deleteMany({ where: { shopId: { in: ids } } });
    await prisma.service.deleteMany({ where: { shopId: { in: ids } } });
    await prisma.squareConnection.deleteMany({ where: { shopId: { in: ids } } });
    await prisma.shop.deleteMany({ where: { id: { in: ids } } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("recording the intent", () => {
  it("writes a PENDING row in the caller's transaction", async () => {
    const appt = await makeAppointment();
    const id = await intentFor(appt.id, appt.startsAt, appt.endsAt);
    expect(id).not.toBeNull();
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id: id! } });
    expect(row).toMatchObject({
      state: "PENDING",
      squareLocationId: "L1",
      squareTeamMemberId: "TM1",
      squareServiceVariationId: "VAR1",
      squareServiceVariationVersion: "100",
    });
    // The snapshots are copies, not joins: a later remap must not strand the
    // cancel on the wrong team member.
    expect(row!.idempotencyKey).toContain(appt.id);
  });

  it("RECORDS NOTHING while the shop is only rehearsing", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "OBSERVE" } });
    const appt = await makeAppointment();
    expect(await intentFor(appt.id, appt.startsAt, appt.endsAt)).toBeNull();
    expect(await prisma.squareOutboundBooking.count({ where: { shopId } })).toBe(0);
  });

  it("refuses LOUDLY when the shop enforces but the chair is unmapped", async () => {
    // Silence here would mean an appointment that exists in ChairBack and is
    // still on sale in Square - the exact bug the feature exists to stop.
    await prisma.staff.update({
      where: { id: staffId },
      data: { squareTeamMemberId: null, squareTeamMemberMappedGeneration: null },
    });
    const appt = await makeAppointment();
    await expect(intentFor(appt.id, appt.startsAt, appt.endsAt)).rejects.toBeInstanceOf(
      SquareMirrorNotConfiguredError,
    );
    await prisma.staff.update({
      where: { id: staffId },
      data: { squareTeamMemberId: "TM1", squareTeamMemberMappedGeneration: 1 },
    });
  });

  it("refuses when the mapping went stale on a re-authorization", async () => {
    await prisma.squareConnection.update({
      where: { shopId },
      data: { connectionGeneration: 2 },
    });
    const appt = await makeAppointment();
    await expect(intentFor(appt.id, appt.startsAt, appt.endsAt)).rejects.toBeInstanceOf(
      SquareMirrorNotConfiguredError,
    );
    await prisma.squareConnection.update({
      where: { shopId },
      data: { connectionGeneration: 1 },
    });
  });

  it("holds ONE LIVE MIRROR PER APPOINTMENT under a real concurrent race", async () => {
    // The engine has no read-then-write pre-check here at all; the partial
    // unique index IS the guarantee, and this proves it holds under Promise.all.
    const appt = await makeAppointment();
    const results = await Promise.allSettled([
      intentFor(appt.id, appt.startsAt, appt.endsAt),
      intentFor(appt.id, appt.startsAt, appt.endsAt),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.squareOutboundBooking.count({ where: { appointmentId: appt.id } })).toBe(1);
  });
});

describe("dispatching the create", () => {
  it("creates the booking and records that Square is HOLDING the chair", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("held");
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    expect(row).toMatchObject({ state: "ACTIVE", squareBookingStatus: "ACCEPTED" });
    expect(row!.squareBookingId).toBeTruthy();
    expect(row!.squareCustomerId).toBe("CUST_1");
  });

  it("sends the SAME idempotency key it stored, so a replay cannot duplicate", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    await dispatchSquareCreate(id);
    expect(squareMock.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: row!.idempotencyKey }),
    );
  });

  it("does NOT call a PENDING booking protection", async () => {
    squareMock.createBooking.mockResolvedValueOnce({
      id: "BK_PENDING",
      version: 1,
      status: "PENDING",
      start_at: soon(90).toISOString(),
      appointment_segments: [],
    });
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("awaiting_seller");
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    // The row is ACTIVE - the booking really does exist - but the STATUS is
    // what any coverage report must read, and it says the chair is not held.
    expect(row).toMatchObject({ state: "ACTIVE", squareBookingStatus: "PENDING" });
  });

  it("REFUSES rather than write over somebody already in that chair", async () => {
    const appt = await makeAppointment();
    squareMock.listBookings.mockResolvedValueOnce({
      bookings: [
        {
          id: "SOMEONE_ELSE",
          status: "ACCEPTED",
          start_at: appt.startsAt.toISOString(),
          appointment_segments: [{ team_member_id: "TM1", duration_minutes: 30 }],
        },
      ],
      cursor: null,
    });
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("conflict");
    expect(squareMock.createBooking).not.toHaveBeenCalled();
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    expect(row).toMatchObject({ state: "FAILED", lastError: "square_conflict" });
  });

  it("catches a conflict that STARTED EARLIER and runs into our span", async () => {
    // Square filters bookings by start_at, so a long appointment beginning
    // before ours is invisible to a window that starts at our start.
    const appt = await makeAppointment();
    squareMock.listBookings.mockResolvedValueOnce({
      bookings: [
        {
          id: "LONG_ONE",
          status: "ACCEPTED",
          start_at: new Date(appt.startsAt.getTime() - 45 * 60_000).toISOString(),
          appointment_segments: [{ team_member_id: "TM1", duration_minutes: 90 }],
        },
      ],
      cursor: null,
    });
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("conflict");
  });

  it("does NOT treat another team member's booking as a conflict", async () => {
    const appt = await makeAppointment();
    squareMock.listBookings.mockResolvedValueOnce({
      bookings: [
        {
          id: "COLLEAGUE",
          status: "ACCEPTED",
          start_at: appt.startsAt.toISOString(),
          appointment_segments: [{ team_member_id: "TM_OTHER", duration_minutes: 30 }],
        },
      ],
      cursor: null,
    });
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("held");
  });

  it("does not mistake OUR OWN booking for a conflict on a retry", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    // Re-dispatch with our own booking now on the calendar.
    await prisma.squareOutboundBooking.update({ where: { id }, data: { state: "PENDING" } });
    squareMock.listBookings.mockResolvedValueOnce({
      bookings: [
        {
          id: row!.squareBookingId!,
          status: "ACCEPTED",
          start_at: appt.startsAt.toISOString(),
          appointment_segments: [{ team_member_id: "TM1", duration_minutes: 30 }],
        },
      ],
      cursor: null,
    });
    expect(await dispatchSquareCreate(id)).toBe("held");
  });

  it("marks an AMBIGUOUS failure UNKNOWN and never compensates", async () => {
    squareMock.createBooking.mockRejectedValueOnce(new SquareError(502, "gateway"));
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("unknown");
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    expect(row!.state).toBe("UNKNOWN");
    // The appointment is untouched: the booking may well exist on Square's side.
    expect(await prisma.appointment.count({ where: { id: appt.id } })).toBe(1);
  });

  it("marks a DEFINITIVE failure FAILED", async () => {
    squareMock.createBooking.mockRejectedValueOnce(new SquareError(400, "bad", "BAD_REQUEST"));
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    expect(await dispatchSquareCreate(id)).toBe("failed");
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe("FAILED");
  });

  it("persists only a SANITIZED error - never a payload, never a name", async () => {
    squareMock.createBooking.mockRejectedValueOnce(
      new SquareError(400, "Square 400 on /v2/bookings", "BAD_REQUEST"),
    );
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    expect(row!.lastError).toBe("square_400_BAD_REQUEST");
    expect(row!.lastError).not.toContain("Marcus");
  });

  it("is idempotent on re-dispatch of an ACTIVE row", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    squareMock.createBooking.mockClear();
    expect(await dispatchSquareCreate(id)).toBe("held");
    expect(squareMock.createBooking).not.toHaveBeenCalled();
  });

  it("refuses to dispatch for a shop that is no longer enforcing", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "OFF" } });
    expect(await dispatchSquareCreate(id)).toBe("skipped");
    expect(squareMock.createBooking).not.toHaveBeenCalled();
  });
});

describe("releasing", () => {
  it("cancels with the CURRENT version, not the one we stored", async () => {
    // A seller who edited the booking in Square moved its version; a stale one
    // is rejected and the time would stay blocked forever.
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    squareMock.getBooking.mockResolvedValueOnce({
      id: "BK_1",
      version: 7,
      status: "ACCEPTED",
      start_at: appt.startsAt.toISOString(),
      appointment_segments: [],
    });
    squareMock.cancelBooking.mockResolvedValueOnce({
      id: "BK_1",
      version: 8,
      status: "CANCELLED_BY_SELLER",
      start_at: appt.startsAt.toISOString(),
      appointment_segments: [],
    });
    await releaseSquareForAppointment(shopId, appt.id);
    expect(squareMock.cancelBooking).toHaveBeenCalledWith(expect.objectContaining({ version: 7 }));
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "RELEASED",
    );
  });

  it("releases even when the shop has been switched OFF", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "OFF" } });
    squareMock.getBooking.mockResolvedValueOnce({ id: "BK_1", version: 1, start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    squareMock.cancelBooking.mockResolvedValueOnce({ id: "BK_1", version: 2, status: "CANCELLED_BY_SELLER", start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    await releaseSquareForAppointment(shopId, appt.id);
    // Switching the feature off must never strand a booking on the seller's
    // calendar with no way to clear it.
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "RELEASED",
    );
  });

  it("keeps the time BLOCKED when the cancel fails", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    squareMock.getBooking.mockRejectedValueOnce(new SquareError(502, "gateway"));
    await releaseSquareForAppointment(shopId, appt.id);
    // RELEASING, not RELEASED: over-blocking for a few minutes is recoverable;
    // saying "free" while Square still shows it taken is how it gets sold twice.
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "RELEASING",
    );
  });

  it("treats an already-deleted booking as released", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    squareMock.getBooking.mockRejectedValueOnce(new SquareError(404, "gone"));
    await releaseSquareForAppointment(shopId, appt.id);
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "RELEASED",
    );
  });

  it("has nothing to cancel for a row that never reached Square", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await releaseSquareForAppointment(shopId, appt.id);
    expect(squareMock.cancelBooking).not.toHaveBeenCalled();
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "RELEASED",
    );
  });
});

describe("rescheduling", () => {
  it("MOVES the booking in place with a versioned update", async () => {
    // Square offers something Acuity does not: an atomic versioned update. So
    // there is no window in which the chair is blocked twice, and none in which
    // it is blocked not at all.
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    const moved = soon(200);
    squareMock.getBooking.mockResolvedValueOnce({ id: "BK_1", version: 3, start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    squareMock.updateBooking.mockResolvedValueOnce({
      id: "BK_1",
      version: 4,
      status: "ACCEPTED",
      start_at: moved.toISOString(),
      appointment_segments: [],
    });
    expect(
      await rescheduleSquareForAppointment(shopId, appt.id, moved, new Date(moved.getTime() + 1800_000)),
    ).toBe("held");

    expect(squareMock.updateBooking).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
    // Exactly ONE booking still - the old one moved, it was not replaced.
    expect(await prisma.squareOutboundBooking.count({ where: { appointmentId: appt.id } })).toBe(1);
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    expect(row!.startsAt.getTime()).toBe(moved.getTime());
    expect(row!.squareBookingVersion).toBe(4);
  });

  it("uses a DIFFERENT idempotency key from the create", async () => {
    // Replaying the create key would return the ORIGINAL booking and silently
    // undo the move.
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    const moved = soon(200);
    squareMock.getBooking.mockResolvedValueOnce({ id: "BK_1", version: 1, start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    squareMock.updateBooking.mockResolvedValueOnce({ id: "BK_1", version: 2, status: "ACCEPTED", start_at: moved.toISOString(), appointment_segments: [] });
    await rescheduleSquareForAppointment(shopId, appt.id, moved, new Date(moved.getTime() + 1800_000));
    const key = squareMock.updateBooking.mock.calls[0]![0].idempotencyKey as string;
    expect(key).not.toBe(row!.idempotencyKey);
  });

  it("keeps the OLD span blocked when the move is refused", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    squareMock.getBooking.mockResolvedValueOnce({ id: "BK_1", version: 1, start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    squareMock.updateBooking.mockRejectedValueOnce(
      new SquareError(409, "stale", "VERSION_MISMATCH"),
    );
    const moved = soon(200);
    expect(
      await rescheduleSquareForAppointment(shopId, appt.id, moved, new Date(moved.getTime() + 1800_000)),
    ).toBe("failed");
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    // The stored span is still the OLD one - which is the truth about Square,
    // and it keeps that time held rather than putting it back on sale.
    expect(row!.startsAt.getTime()).toBe(appt.startsAt.getTime());
  });
});

describe("the reconciler", () => {
  it("replays an UNKNOWN row with the same key and settles it", async () => {
    squareMock.createBooking.mockRejectedValueOnce(new SquareError(504, "timeout"));
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "UNKNOWN",
    );

    const result = await reconcileSquareShop(shopId);
    expect(result.retried).toBe(1);
    const row = await prisma.squareOutboundBooking.findUnique({ where: { id } });
    expect(row!.state).toBe("ACTIVE");
    // The SAME key both times - which is what makes Square return the original
    // booking rather than making a second one.
    const keys = squareMock.createBooking.mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("finishes a release that was interrupted", async () => {
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    await prisma.squareOutboundBooking.update({ where: { id }, data: { state: "RELEASING" } });
    squareMock.getBooking.mockResolvedValueOnce({ id: "BK_1", version: 1, start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    squareMock.cancelBooking.mockResolvedValueOnce({ id: "BK_1", version: 2, status: "CANCELLED_BY_SELLER", start_at: appt.startsAt.toISOString(), appointment_segments: [] });
    const result = await reconcileSquareShop(shopId);
    expect(result.released).toBe(1);
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "RELEASED",
    );
  });

  it("does nothing for a shop with no connection", async () => {
    expect(await reconcileSquareShop(otherShopId)).toEqual({ retried: 0, released: 0 });
  });
});

describe("the scheduled sweep", () => {
  it("reconciles a shop that has SQUARE but no Acuity connection", async () => {
    // The sweep used to iterate AcuityConnection rows only. A Square-only shop
    // has none, so its UNKNOWN rows would have sat there forever - the "worker
    // ships dead" failure in a different disguise.
    expect(await prisma.acuityConnection.count({ where: { shopId } })).toBe(0);

    squareMock.createBooking.mockRejectedValueOnce(new SquareError(504, "timeout"));
    const appt = await makeAppointment();
    const id = (await intentFor(appt.id, appt.startsAt, appt.endsAt))!;
    await dispatchSquareCreate(id);
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "UNKNOWN",
    );

    const result = await runAcuityOutboundReconcile();
    expect(result.squareRetried).toBeGreaterThanOrEqual(1);
    expect((await prisma.squareOutboundBooking.findUnique({ where: { id } }))!.state).toBe(
      "ACTIVE",
    );
  });
});

describe("tenant isolation", () => {
  it("never mirrors another shop's appointment", async () => {
    const mine = await makeAppointment();
    const id = (await intentFor(mine.id, mine.startsAt, mine.endsAt))!;
    await dispatchSquareCreate(id);
    const rows = await prisma.squareOutboundBooking.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shopId).toBe(shopId);
  });
});
