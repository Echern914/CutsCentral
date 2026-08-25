import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { processBookingEvent } from "./inbox.js";
import { parseSquareEventRef, squareEventAdvances } from "../engines/squareMirrorRules.js";

/**
 * OUT-OF-ORDER DELIVERY.
 *
 * Square does not guarantee webhook ordering. That is survivable for the
 * inbound path, which re-reads the booking from Square and therefore always
 * writes current state - but NOT for a booking ChairBack owns:
 * reconcileOwnedBookingFromWebhook takes the status straight off the envelope.
 * A stale ACCEPTED arriving after a CANCELLED_BY_SELLER would repaint a chair
 * that is no longer protected as protected, and nothing downstream would ever
 * notice.
 *
 * The three events replayed below are the real sequence captured from a live
 * sandbox delivery on 2026-08-25 - create, reschedule, cancel - identified by
 * `data.id` values of `f7i4eiij0bdkm3:0`, `:1` and `:2`.
 */

const squareMock = vi.hoisted(() => ({
  getBooking: vi.fn(),
  getCustomer: vi.fn(async () => ({ id: "C1", given_name: "Ada", family_name: "Lovelace" })),
  listBookings: vi.fn(async () => ({ bookings: [], cursor: null })),
  listLocations: vi.fn(),
  getBusinessBookingProfile: vi.fn(),
  listTeamMemberBookingProfiles: vi.fn(),
  listServiceCatalogItems: vi.fn(),
  getTokenStatus: vi.fn(),
  ensureCustomer: vi.fn(),
  searchAvailability: vi.fn(),
  createBooking: vi.fn(),
  updateBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, getSquareClientForShop: vi.fn(async () => squareMock) };
});

const BOOKING_ID = "f7i4eiij0bdkm3";

/** The captured sequence, oldest first. */
const CAPTURED = [
  { dataId: `${BOOKING_ID}:0`, type: "booking.created", status: "ACCEPTED" },
  { dataId: `${BOOKING_ID}:1`, type: "booking.updated", status: "ACCEPTED" },
  { dataId: `${BOOKING_ID}:2`, type: "booking.updated", status: "CANCELLED_BY_SELLER" },
] as const;

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const START = new Date("2026-10-06T15:00:00.000Z");
const END = new Date("2026-10-06T15:30:00.000Z");

async function ownedRowAt(version: number, status: string) {
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Marcus",
      lastName: "Holloway",
      phone: "+15555550123",
      status: "BOOKED",
      startsAt: START,
      endsAt: END,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return prisma.squareOutboundBooking.create({
    data: {
      shopId,
      appointmentId: appt.id,
      staffId,
      serviceId,
      squareLocationId: "L1",
      squareTeamMemberId: "TM1",
      squareServiceVariationId: "VAR1",
      squareServiceVariationVersion: "1787679374841",
      startsAt: START,
      endsAt: END,
      idempotencyKey: `idem-${randomToken(10)}`,
      state: "ACTIVE",
      squareBookingId: BOOKING_ID,
      squareBookingVersion: version,
      squareBookingStatus: status,
    },
    select: { id: true },
  });
}

/** Deliver one captured event exactly as the route would. */
async function deliver(e: { dataId: string; type: string; status: string }) {
  const ref = parseSquareEventRef(e.dataId);
  squareMock.getBooking.mockResolvedValue({
    id: BOOKING_ID,
    status: e.status,
    start_at: START.toISOString(),
    customer_id: "C1",
    appointment_segments: [{ duration_minutes: 30 }],
  });
  return processBookingEvent({ id: shopId } as never, BOOKING_ID, e.status, null, ref.version);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqord-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Ordering Shop",
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
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
  });
  serviceId = service.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Dre" } });
  staffId = staff.id;
});

beforeEach(() => {
  vi.clearAllMocks();
  squareMock.getCustomer.mockResolvedValue({ id: "C1", given_name: "Ada", family_name: "Lovelace" });
  squareMock.listBookings.mockResolvedValue({ bookings: [], cursor: null });
});

afterEach(async () => {
  if (!shopId) return;
  await prisma.squareWebhookEvent.deleteMany({ where: { shopId } });
  await prisma.squareOutboundBooking.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  if (shopId) {
    await prisma.squareConnection.deleteMany({ where: { shopId } });
    await prisma.staff.deleteMany({ where: { shopId } });
    await prisma.service.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("parseSquareEventRef - data.id is not the booking id", () => {
  it("splits the real captured ids", () => {
    expect(parseSquareEventRef("f7i4eiij0bdkm3:0")).toEqual({ bookingId: BOOKING_ID, version: 0 });
    expect(parseSquareEventRef("f7i4eiij0bdkm3:1")).toEqual({ bookingId: BOOKING_ID, version: 1 });
    expect(parseSquareEventRef("f7i4eiij0bdkm3:2")).toEqual({ bookingId: BOOKING_ID, version: 2 });
  });

  it("splits on the LAST colon, so an id containing one still works", () => {
    expect(parseSquareEventRef("weird:id:7")).toEqual({ bookingId: "weird:id", version: 7 });
  });

  it("returns a null version rather than pretending zero", () => {
    // Zero is a REAL version - the one a create carries - so defaulting to it
    // would make every unversioned event look like the oldest possible state.
    expect(parseSquareEventRef("f7i4eiij0bdkm3")).toEqual({ bookingId: BOOKING_ID, version: null });
    expect(parseSquareEventRef("f7i4eiij0bdkm3:")).toEqual({
      bookingId: "f7i4eiij0bdkm3:",
      version: null,
    });
    expect(parseSquareEventRef("f7i4eiij0bdkm3:abc").version).toBeNull();
    expect(parseSquareEventRef(null)).toEqual({ bookingId: null, version: null });
    expect(parseSquareEventRef("")).toEqual({ bookingId: null, version: null });
  });
});

describe("squareEventAdvances", () => {
  it("accepts a newer version and refuses an older one", () => {
    expect(squareEventAdvances(1, 0)).toBe(true);
    expect(squareEventAdvances(0, 1)).toBe(false);
  });

  it("refuses an EQUAL version - same version, same state", () => {
    expect(squareEventAdvances(2, 2)).toBe(false);
  });

  it("fails OPEN when either side is unknown", () => {
    // Dropping an event we cannot order is worse than processing one twice,
    // which the event_id ledger already absorbs.
    expect(squareEventAdvances(null, 4)).toBe(true);
    expect(squareEventAdvances(4, null)).toBe(true);
    expect(squareEventAdvances(null, null)).toBe(true);
  });
});

describe("the captured sequence, replayed BACKWARDS", () => {
  it("keeps the cancellation and drops the two older events", async () => {
    // Owned booking, nothing applied yet.
    const row = await ownedRowAt(0, "ACCEPTED");

    const reversed = [...CAPTURED].reverse(); // v2, v1, v0
    const outcomes: string[] = [];
    for (const e of reversed) outcomes.push(await deliver(e));

    // v2 (cancel) lands. v1 and v0 both describe older state.
    expect(outcomes).toEqual(["self_echo", "stale", "stale"]);

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    // The chair is NOT protected, and the last word is the cancellation - not
    // the ACCEPTED that arrived after it.
    expect(after!.squareBookingStatus).toBe("CANCELLED_BY_SELLER");
    expect(after!.squareBookingVersion).toBe(2);
    expect(after!.state).toBe("FAILED");
    expect(after!.lastError).toBe("cancelled_in_square");
  });

  it("applies the same three IN ORDER and ends in the same place", async () => {
    // The guard must not change the outcome of correctly ordered delivery.
    const row = await ownedRowAt(0, "ACCEPTED");
    // v0 equals what is already applied, so it is correctly a no-op.
    const outcomes: string[] = [];
    for (const e of CAPTURED) outcomes.push(await deliver(e));
    expect(outcomes).toEqual(["stale", "self_echo", "self_echo"]);

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.squareBookingStatus).toBe("CANCELLED_BY_SELLER");
    expect(after!.squareBookingVersion).toBe(2);
  });

  it("WITHOUT the version, a late ACCEPTED would win - which is the bug", async () => {
    // Same replay, versions withheld. This documents what the guard is for:
    // the last writer wins, and the last writer is the oldest event.
    const row = await ownedRowAt(0, "ACCEPTED");
    for (const e of [...CAPTURED].reverse()) {
      squareMock.getBooking.mockResolvedValue({
        id: BOOKING_ID,
        status: e.status,
        start_at: START.toISOString(),
        customer_id: "C1",
        appointment_segments: [{ duration_minutes: 30 }],
      });
      await processBookingEvent({ id: shopId } as never, BOOKING_ID, e.status, null, null);
    }
    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.squareBookingStatus).toBe("ACCEPTED"); // the stale one won
  });

  it("orders an INBOUND booking off the webhook ledger", async () => {
    // A booking we do not own has no outbound row, so the high water mark comes
    // from events that reached PROCESSED.
    await prisma.squareWebhookEvent.create({
      data: {
        eventId: `evt-${randomToken(8)}`,
        merchantId: "M",
        type: "booking.updated",
        shopId,
        bookingId: "BK_INBOUND",
        bookingVersion: 5,
        status: "PROCESSED",
      },
    });
    squareMock.getBooking.mockResolvedValue({
      id: "BK_INBOUND",
      status: "ACCEPTED",
      start_at: START.toISOString(),
      customer_id: "C1",
      appointment_segments: [{ duration_minutes: 30 }],
    });

    const stale = await processBookingEvent(
      { id: shopId } as never,
      "BK_INBOUND",
      "ACCEPTED",
      null,
      3,
    );
    expect(stale).toBe("stale");
    expect(await prisma.visit.count({ where: { shopId } })).toBe(0);

    const fresh = await processBookingEvent(
      { id: shopId } as never,
      "BK_INBOUND",
      "ACCEPTED",
      null,
      6,
    );
    expect(fresh).toBe("ingested");
  });

  it("ignores a ledger row that has not been PROCESSED", async () => {
    // A RECEIVED or FAILED row describes work we did NOT apply, so it must not
    // suppress the retry that finally does.
    await prisma.squareWebhookEvent.create({
      data: {
        eventId: `evt-${randomToken(8)}`,
        merchantId: "M",
        type: "booking.updated",
        shopId,
        bookingId: "BK_FAILED",
        bookingVersion: 9,
        status: "FAILED",
      },
    });
    squareMock.getBooking.mockResolvedValue({
      id: "BK_FAILED",
      status: "ACCEPTED",
      start_at: START.toISOString(),
      customer_id: "C1",
      appointment_segments: [{ duration_minutes: 30 }],
    });
    const outcome = await processBookingEvent({ id: shopId } as never, "BK_FAILED", "ACCEPTED", null, 4);
    expect(outcome).toBe("ingested");
  });
});

describe("the handler switches on STATUS, never on event type", () => {
  it("releases on a cancelled status even when the type says booking.CREATED", async () => {
    // There is no booking.canceled event - a cancellation arrives as
    // booking.updated - so any branch on event type would be wrong by
    // construction. Behaviour must follow status alone.
    const row = await ownedRowAt(0, "ACCEPTED");
    squareMock.getBooking.mockResolvedValue({
      id: BOOKING_ID,
      status: "CANCELLED_BY_SELLER",
      start_at: START.toISOString(),
      customer_id: "C1",
      appointment_segments: [{ duration_minutes: 30 }],
    });
    // Type is deliberately not passed to processBookingEvent at all.
    await processBookingEvent({ id: shopId } as never, BOOKING_ID, "CANCELLED_BY_SELLER", null, 1);

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.state).toBe("FAILED");
    expect(after!.lastError).toBe("cancelled_in_square");
  });

  it("holds on an ACCEPTED status regardless of which event carried it", async () => {
    const row = await ownedRowAt(0, "ACCEPTED");
    await processBookingEvent({ id: shopId } as never, BOOKING_ID, "ACCEPTED", null, 1);
    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.state).toBe("ACTIVE");
  });

  it("the route source contains no branch on booking.created / booking.updated", () => {
    // A guard, not a style check. Square publishes exactly two booking
    // lifecycle events and a cancel is one of them wearing the other's name;
    // the day someone adds `if (type === "booking.created")` the cancel path
    // silently stops working.
    const route = readFileSync(
      fileURLToPath(new URL("../routes/webhooks.square.ts", import.meta.url)),
      "utf8",
    );
    const code = route
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/^\s*\/\/.*$/gm, ""); // line comments
    expect(code).not.toMatch(/["'`]booking\.created["'`]/);
    expect(code).not.toMatch(/["'`]booking\.updated["'`]/);
    // The one type comparison that IS legitimate stays.
    expect(code).toMatch(/oauth\.authorization\.revoked/);
  });
});

describe("who released a mirrored booking", () => {
  /**
   * Direction, confirmed: SURFACE, never auto-cancel. The ChairBack
   * appointment is left completely alone in every case below - a barber
   * tidying their Square calendar must not silently cancel a customer who was
   * told they were booked.
   *
   * What changes is how it is FILED. Square gives actor class and nothing
   * finer, but that split is decisive on a mirror booking: a seller cancel is
   * expected, a CUSTOMER cancel should be close to impossible, because a
   * mirror is filed under a name-only customer with no email and no phone.
   */
  it("files a SELLER cancel as ordinary, and leaves the appointment alone", async () => {
    const row = await ownedRowAt(0, "ACCEPTED");
    const before = await prisma.appointment.findFirstOrThrow({ where: { shopId } });

    await deliver({ dataId: `${BOOKING_ID}:1`, type: "booking.updated", status: "CANCELLED_BY_SELLER" });

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.state).toBe("FAILED");
    expect(after!.lastError).toBe("cancelled_in_square");

    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: before.id } });
    expect(appt.status).toBe("BOOKED");
    expect(appt.canceledAt).toBeNull();
  });

  it("files a CUSTOMER cancel under its OWN code - it is anomalous", async () => {
    // A name-only Square customer has no channel by which anyone could have
    // been handed a cancel link. If this fires, an assumption the design rests
    // on is wrong, and it must not disappear into the same bucket as a barber
    // tidying up.
    const row = await ownedRowAt(0, "ACCEPTED");
    const before = await prisma.appointment.findFirstOrThrow({ where: { shopId } });

    await deliver({ dataId: `${BOOKING_ID}:1`, type: "booking.updated", status: "CANCELLED_BY_CUSTOMER" });

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.state).toBe("FAILED");
    expect(after!.lastError).toBe("cancelled_by_customer_in_square");
    expect(after!.lastError).not.toBe("cancelled_in_square");

    // Still surfaced, still never destructive.
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: before.id } });
    expect(appt.status).toBe("BOOKED");
    expect(appt.canceledAt).toBeNull();
  });

  it("files a NO_SHOW as its own thing rather than as a cancellation", async () => {
    const row = await ownedRowAt(0, "ACCEPTED");
    await deliver({ dataId: `${BOOKING_ID}:1`, type: "booking.updated", status: "NO_SHOW" });
    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.lastError).toBe("no_show_in_square");
  });
});
