import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { processBookingEvent } from "./inbox.js";

/**
 * W3: DOES OUR OWN MIRRORED BOOKING COME BACK AS A PHANTOM SECOND APPOINTMENT?
 *
 * Every fixture in this file is shaped from a payload Square actually delivered
 * to a tunnel on 2026-08-25, not from the documentation. Two properties of that
 * real payload are load-bearing and neither was assumed beforehand:
 *
 *   - the FULL booking object is present, `seller_note` included, so the note
 *     ChairBack writes at create time is readable on the way back in;
 *   - `data.id` is `"<bookingId>:<version>"`, NOT the bare booking id, so the
 *     id must be read from `data.object.booking.id`.
 *
 * The gap being defended is a race, and it is narrow but entirely real:
 *
 *      dispatchSquareCreate:  createBooking() ─────────────► Square
 *                                                             │
 *                             (Square fires booking.created)  │
 *                                                             ▼
 *      webhook handler:                          processBookingEvent()
 *      dispatchSquareCreate:  update(squareBookingId) ◄── still in flight
 *
 * `ownedSquareBookingIds` selects `squareBookingId: { not: null }`, so inside
 * that window the booking ChairBack just created is invisible to the self-echo
 * check and gets imported as a Visit - a phantom appointment on a chair that is
 * already booked, created by the very mechanism meant to protect it.
 *
 * The seller note is what closes it. It is written before Square ever sees the
 * booking, it comes back in the payload, and it names the outbox row.
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

let userId: string;
let shopId: string;
let otherShopId: string;
let staffId: string;
let serviceId: string;

const START = new Date("2026-10-06T15:00:00.000Z");
const END = new Date("2026-10-06T15:30:00.000Z");

/** The exact booking object Square delivered, parameterised by id and note. */
function realBooking(id: string, sellerNote: string | null, status = "ACCEPTED") {
  return {
    id,
    status,
    version: 0,
    all_day: false,
    created_at: "2026-08-25T17:50:31Z",
    updated_at: "2026-08-25T17:50:31Z",
    customer_id: "ET6HNPJM0XAY6VYVKQY8X1WE44",
    location_id: "L1",
    location_type: "BUSINESS_LOCATION",
    source: "API",
    creator_details: { creator_type: "TEAM_MEMBER", team_member_id: "TM1" },
    transition_time_minutes: 0,
    start_at: START.toISOString(),
    ...(sellerNote === null ? {} : { seller_note: sellerNote }),
    appointment_segments: [
      {
        any_team_member: false,
        duration_minutes: 30,
        intermission_minutes: 0,
        service_variation_client_id: "VAR1",
        service_variation_id: "VAR1",
        service_variation_version: 1787679374841,
        team_member_id: "TM1",
      },
    ],
  };
}

async function makeAppointment(shop = shopId) {
  return prisma.appointment.create({
    data: {
      shopId: shop,
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
}

/**
 * An outbox row mid-flight: the create has been sent to Square but the response
 * has not been written back yet, so `squareBookingId` is still null.
 */
async function inFlightOutboxRow(appointmentId: string, shop = shopId) {
  return prisma.squareOutboundBooking.create({
    data: {
      shopId: shop,
      appointmentId,
      staffId,
      serviceId,
      squareLocationId: "L1",
      squareTeamMemberId: "TM1",
      squareServiceVariationId: "VAR1",
      squareServiceVariationVersion: "1787679374841",
      startsAt: START,
      endsAt: END,
      idempotencyKey: `idem-${randomToken(10)}`,
      state: "PENDING",
      squareBookingId: null,
    },
    select: { id: true },
  });
}

async function visitCount(shop = shopId) {
  return prisma.visit.count({ where: { shopId: shop } });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqecho-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Echo Shop",
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
      squareServiceVariationVersion: "1787679374841",
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
      name: "Other Echo Shop",
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      squareOutboundMode: "ENFORCE",
    },
  });
  otherShopId = other.id;
});

beforeEach(() => {
  vi.clearAllMocks();
  squareMock.getCustomer.mockResolvedValue({ id: "C1", given_name: "Ada", family_name: "Lovelace" });
  squareMock.listBookings.mockResolvedValue({ bookings: [], cursor: null });
});

afterEach(async () => {
  // 🔴 Guarded: Prisma reads `{ shopId: undefined }` as NO FILTER, so an
  // unguarded cleanup after a failed beforeAll would empty the shared test DB.
  for (const id of [shopId, otherShopId].filter(Boolean)) {
    await prisma.squareOutboundBooking.deleteMany({ where: { shopId: id } });
    await prisma.visit.deleteMany({ where: { shopId: id } });
    await prisma.client.deleteMany({ where: { shopId: id } });
    await prisma.appointment.deleteMany({ where: { shopId: id } });
  }
});

afterAll(async () => {
  for (const id of [shopId, otherShopId].filter(Boolean)) {
    await prisma.serviceStaff.deleteMany({ where: { shopId: id } });
    await prisma.squareConnection.deleteMany({ where: { shopId: id } });
    await prisma.staff.deleteMany({ where: { shopId: id } });
    await prisma.service.deleteMany({ where: { shopId: id } });
    await prisma.shop.deleteMany({ where: { id } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("W3: a mirrored booking coming home", () => {
  it("does NOT import a second Visit when the webhook beats the id being persisted", async () => {
    // The failure this whole file exists for. Square accepted the booking and
    // fired booking.created; our own UPDATE writing squareBookingId has not
    // landed yet. The only thing identifying the booking as ours is the note.
    const appt = await makeAppointment();
    const row = await inFlightOutboxRow(appt.id);
    const bookingId = "f7i4eiij0bdkm3";
    const booking = realBooking(bookingId, `ChairBack ref ${row.id}`);
    squareMock.getBooking.mockResolvedValue(booking);

    const outcome = await processBookingEvent(
      { id: shopId } as never,
      bookingId,
      booking.status,
      booking.seller_note,
    );

    expect(outcome).toBe("self_echo");
    expect(await visitCount()).toBe(0);
  });

  it("adopts the booking id so the follow-up booking.updated is recognised too", async () => {
    // Closing the race is not enough on its own: the reschedule and cancel
    // events that follow must also be recognised, and by then the note check
    // should no longer be doing the work.
    const appt = await makeAppointment();
    const row = await inFlightOutboxRow(appt.id);
    const bookingId = "f7i4eiij0bdkm3";
    const booking = realBooking(bookingId, `ChairBack ref ${row.id}`);
    squareMock.getBooking.mockResolvedValue(booking);

    await processBookingEvent({ id: shopId } as never, bookingId, "ACCEPTED", booking.seller_note);

    const after = await prisma.squareOutboundBooking.findUnique({ where: { id: row.id } });
    expect(after!.squareBookingId).toBe(bookingId);

    // Now the owned-id path carries it, with no note at all.
    const outcome = await processBookingEvent({ id: shopId } as never, bookingId, "ACCEPTED", null);
    expect(outcome).toBe("self_echo");
    expect(await visitCount()).toBe(0);
  });

  it("still recognises a booking whose id was already persisted", async () => {
    // The pre-existing path, unchanged - proves the new check is additive.
    const appt = await makeAppointment();
    const row = await inFlightOutboxRow(appt.id);
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: { squareBookingId: "BK_SETTLED", state: "ACTIVE" },
    });
    squareMock.getBooking.mockResolvedValue(realBooking("BK_SETTLED", null));

    const outcome = await processBookingEvent({ id: shopId } as never, "BK_SETTLED", "ACCEPTED", null);
    expect(outcome).toBe("self_echo");
    expect(await visitCount()).toBe(0);
  });
});

describe("what must STILL be imported", () => {
  it("imports a genuine seller booking that carries no ChairBack note", async () => {
    // Over-suppressing is its own bug: a real customer booked in Square and the
    // chair must be blocked in ChairBack.
    squareMock.getBooking.mockResolvedValue(realBooking("BK_SELLER", null));

    const outcome = await processBookingEvent({ id: shopId } as never, "BK_SELLER", "ACCEPTED", null);
    expect(outcome).toBe("ingested");
    expect(await visitCount()).toBe(1);
  });

  it("imports a booking whose note LOOKS like ours but names nothing real", async () => {
    // A barber can type anything into the note field. Only a note naming a row
    // that actually exists may suppress an import.
    squareMock.getBooking.mockResolvedValue(realBooking("BK_FAKE", "ChairBack ref not-a-real-row"));

    const outcome = await processBookingEvent(
      { id: shopId } as never,
      "BK_FAKE",
      "ACCEPTED",
      "ChairBack ref not-a-real-row",
    );
    expect(outcome).toBe("ingested");
    expect(await visitCount()).toBe(1);
  });

  it("does not let ANOTHER shop's outbox row suppress this shop's import", async () => {
    // The note is attacker-controllable in the sense that it is copyable: a
    // seller who pastes another shop's note must not be able to make bookings
    // vanish from a shop they do not own.
    const otherAppt = await makeAppointment(otherShopId);
    const otherRow = await inFlightOutboxRow(otherAppt.id, otherShopId);
    squareMock.getBooking.mockResolvedValue(realBooking("BK_XSHOP", `ChairBack ref ${otherRow.id}`));

    const outcome = await processBookingEvent(
      { id: shopId } as never,
      "BK_XSHOP",
      "ACCEPTED",
      `ChairBack ref ${otherRow.id}`,
    );
    expect(outcome).toBe("ingested");
    expect(await visitCount(shopId)).toBe(1);
  });
});
