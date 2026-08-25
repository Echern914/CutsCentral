import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { dispatchSquareCreate, recordSquareIntent } from "./squareMirror.js";

/**
 * 🔴 A MIRRORED BOOKING MUST NEVER CARRY THE CUSTOMER'S EMAIL OR PHONE.
 *
 * This began as a privacy rule - the mirror holds a slot, it does not copy a
 * shop's contact book into a third party - and C14 turned it into a safety one.
 *
 * Whether Square emails or texts the CUSTOMER about a booking is a per-seller
 * dashboard toggle (Appointments > Settings > Communications) that the API
 * cannot read, cannot verify, and that makes no distinction between a booking
 * a customer made and one an app created. We therefore cannot know whether a
 * given seller notifies. What we CAN control is whether there is anywhere to
 * notify.
 *
 * A mirror is a hold, not an appointment the customer made in Square. If it
 * carried their contact details, a seller's settings could send a stranger
 * "your appointment is confirmed" for something they never booked - and, if
 * that message carries Square's own cancel link, let them release a chair
 * ChairBack believes is protected.
 *
 * The appointment fixture below deliberately HAS both an email and a phone, so
 * this fails the moment someone helpfully passes them through.
 */

const squareMock = vi.hoisted(() => ({
  getBooking: vi.fn(),
  listBookings: vi.fn(async () => ({ bookings: [], cursor: null })),
  getCustomer: vi.fn(),
  listLocations: vi.fn(async () => [{ id: "L1", name: "Main", status: "ACTIVE" }]),
  getBusinessBookingProfile: vi.fn(async () => ({
    booking_enabled: true,
    support_seller_level_writes: true,
  })),
  listTeamMemberBookingProfiles: vi.fn(async () => []),
  listServiceCatalogItems: vi.fn(async () => []),
  getTokenStatus: vi.fn(async () => ({ scopes: [] })),
  ensureCustomer: vi.fn(async () => ({ id: "CUST_1" })),
  searchAvailability: vi.fn(async () => []),
  createBooking: vi.fn(async (input: { startAt: string }) => ({
    id: `BK_${randomToken(6)}`,
    version: 1,
    status: "ACCEPTED",
    start_at: input.startAt,
    appointment_segments: [],
  })),
  updateBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock("../square/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../square/client.js")>();
  return { ...actual, getSquareClientForShop: vi.fn(async () => squareMock) };
});


/**
 * The mocks are declared with zero-arg implementations, so vitest types
 * `mock.calls` as `[][]` and indexing it is a compile error - which the Railway
 * build catches even though vitest runs it happily. Read the args through one
 * deliberate widening rather than scattering casts.
 */
function firstArg(fn: unknown): Record<string, unknown> {
  const calls = (fn as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;

const soon = (min: number) => new Date(Date.now() + min * 60_000);

/** An appointment with FULL contact details - the thing that must not leak. */
async function appointmentWithContact() {
  const startsAt = soon(120);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Marcus",
      lastName: "Holloway",
      phone: "+15555550123",
      email: "marcus@example.test",
      status: "BOOKED",
      startsAt,
      endsAt,
      manageToken: randomToken(),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const outboxId = await prisma.$transaction((tx) =>
    recordSquareIntent(tx, {
      shopId,
      appointmentId: appt.id,
      staffId,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      occupancy: {
        status: "BOOKED",
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        holdExpiresAt: null,
        visitId: null,
      },
    }),
  );
  return outboxId!;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqcust-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Customer Shop",
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
});

beforeEach(() => {
  vi.clearAllMocks();
  squareMock.ensureCustomer.mockResolvedValue({ id: "CUST_1" });
  squareMock.listBookings.mockResolvedValue({ bookings: [], cursor: null });
  squareMock.searchAvailability.mockResolvedValue([]);
});

afterEach(async () => {
  if (!shopId) return;
  await prisma.squareOutboundBooking.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  if (shopId) {
    await prisma.serviceStaff.deleteMany({ where: { shopId } });
    await prisma.squareConnection.deleteMany({ where: { shopId } });
    await prisma.staff.deleteMany({ where: { shopId } });
    await prisma.service.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("the mirror's Square customer", () => {
  it("carries NO email and NO phone, even though the appointment has both", async () => {
    const outboxId = await appointmentWithContact();
    await dispatchSquareCreate(outboxId);

    expect(squareMock.ensureCustomer).toHaveBeenCalledTimes(1);
    const arg = firstArg(squareMock.ensureCustomer);

    // Not "falsy" - ABSENT. A key present and null is a key someone can fill in.
    expect(arg.emailAddress).toBeUndefined();
    expect(arg.phoneNumber).toBeUndefined();

    // And nothing that merely LOOKS like contact detail slipped in elsewhere.
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("marcus@example.test");
    expect(serialized).not.toContain("5555550123");
  });

  it("still carries the name, so the barber's calendar is readable", async () => {
    // Over-correcting into an anonymous booking would leave a barber staring at
    // a nameless block they cannot reconcile with anything.
    const outboxId = await appointmentWithContact();
    await dispatchSquareCreate(outboxId);

    const arg = firstArg(squareMock.ensureCustomer);
    expect(arg.givenName).toBe("Marcus");
    expect(arg.familyName).toBe("Holloway");
  });

  it("scopes the reference id to the shop, so it cannot collide across tenants", async () => {
    const outboxId = await appointmentWithContact();
    await dispatchSquareCreate(outboxId);

    const arg = firstArg(squareMock.ensureCustomer);
    expect(String(arg.referenceId)).toContain(shopId);
  });

  it("never sends contact detail to CreateBooking either", async () => {
    // The booking payload is the other place a well-meaning change could put
    // an email - Square accepts a customer_note, and it is not a safe home.
    const outboxId = await appointmentWithContact();
    await dispatchSquareCreate(outboxId);

    const serialized = JSON.stringify(firstArg(squareMock.createBooking));
    expect(serialized).not.toContain("marcus@example.test");
    expect(serialized).not.toContain("5555550123");
    expect(serialized).not.toContain("Marcus");
  });
});
