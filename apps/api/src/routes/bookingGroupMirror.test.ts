import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { shopDayAhead } from "../testing/shopDay.js";

/**
 * A GROUP BOOKING HAS TO PROTECT THE BARBER'S ACUITY CALENDAR.
 *
 * 🔴 THIS IS THE GAP THIS FILE WAS WRITTEN FOR. The group endpoints shipped
 * writing appointments and NO Acuity blocks. On an ENFORCE shop - and two real
 * shops are ENFORCE-live - that leaves the barber's Acuity calendar sellable
 * over three chairs ChairBack has already promised. It is the same failure
 * that let a ChairBack booking which had held 6:10pm for eleven days get sold
 * over from the Acuity side, multiplied by the size of the party.
 *
 * The mock is hoisted so the client is replaced before the app module graph
 * loads; otherwise the route reaches the real Acuity client.
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

const { createApp } = await import("../app.js");
const { AcuityError } = await import("../acuity/client.js");
const app = createApp();

const TZ = "America/New_York";
const DAY = shopDayAhead(7, TZ, { avoidDstChange: true });
const at = (min: number) => zonedWallTimeToUtc(DAY.y, DAY.m0, DAY.d, min, TZ);
const TWO_PM = at(14 * 60);

let userId: string;
let slug: string;
let shopId: string;
let mappedStaffId: string;
let unmappedStaffId: string;
let cutId: string;
let kidsId: string;

const booker = { firstName: "Eric", lastName: "Chern", phone: "+12015550134", email: "eric@test.chairback" };

async function offer(serviceId: string, staffId: string) {
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `gmir-${randomToken(6)}@test.local`, passwordHash: "x", name: "G" },
  });
  userId = user.id;
  slug = `gmir-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Mirror Cuts",
      slug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 2,
      bookingMaxDays: 60,
      acuityOutboundMode: "ENFORCE",
    },
    select: { id: true },
  });
  shopId = shop.id;
  await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "acct", accessToken: "enc" },
  });

  const mapped = await prisma.staff.create({
    data: { shopId, name: "Sam", acuityCalendarId: "cal-1" },
    select: { id: true },
  });
  mappedStaffId = mapped.id;
  const unmapped = await prisma.staff.create({
    data: { shopId, name: "Unmapped" },
    select: { id: true },
  });
  unmappedStaffId = unmapped.id;

  const cut = await prisma.service.create({
    data: { shopId, name: "Haircut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  cutId = cut.id;
  const kids = await prisma.service.create({
    data: { shopId, name: "Kids cut", durationMin: 20, price: 25 },
    select: { id: true },
  });
  kidsId = kids.id;
  for (const staffId of [mappedStaffId, unmappedStaffId]) {
    await offer(cutId, staffId);
    await offer(kidsId, staffId);
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId,
        staffId,
        weekday,
        startMin: 10 * 60,
        endMin: 20 * 60,
      })),
    });
  }
});

beforeEach(async () => {
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
  acuityMock.createBlock.mockReset();
  acuityMock.deleteBlock.mockReset();
  acuityMock.deleteBlock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

const createGroup = (staffId: string, attendees: Array<{ firstName: string; serviceId: string }>) =>
  request(app)
    .post(`/api/book/${slug}/group`)
    .send({ staffId, startsAt: TWO_PM.toISOString(), attendees, ...booker });

const live = () =>
  prisma.appointment.findMany({
    where: { shopId, status: "BOOKED" },
    orderBy: { startsAt: "asc" },
    select: { id: true, firstName: true, startsAt: true, endsAt: true },
  });

describe("🔴 every member gets its own Acuity block", () => {
  it("a three-person party writes THREE blocks, one per chair", async () => {
    // Not one block spanning the run: Acuity has no notion of a party, and a
    // single span would be wrong the moment one attendee cancels.
    let n = 0;
    acuityMock.createBlock.mockImplementation(async () => ({ id: `blk-${++n}` }));

    const res = await createGroup(mappedStaffId, [
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
      { firstName: "Dad", serviceId: kidsId },
    ]);
    expect(res.status).toBe(201);
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(3);
    expect(await live()).toHaveLength(3);

    // And each block covers ITS OWN member's span, not the whole visit.
    const spans = acuityMock.createBlock.mock.calls.map((c) => {
      const a = c[0] as { start?: unknown; startsAt?: unknown };
      return a.start ?? a.startsAt;
    });
    expect(new Set(spans.map(String)).size).toBe(3);
  });

  it("records a durable outbox row per block, inside the booking transaction", async () => {
    let n = 0;
    acuityMock.createBlock.mockImplementation(async () => ({ id: `blk-${++n}` }));
    await createGroup(mappedStaffId, [
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    // An appointment can never exist without its intent: the rows are written
    // in the same transaction as the appointments.
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(2);
  });
});

describe("🔴 a definitive refusal undoes the WHOLE party", () => {
  it("leaves ZERO appointments booked, not the ones that happened to land", async () => {
    // 422 is Acuity looking at the request and declining, so no block exists.
    // Keeping the members that landed would leave a family booked for two of
    // three chairs with nobody told which one is missing - exactly the partial
    // success this feature exists to make impossible.
    let n = 0;
    acuityMock.createBlock.mockImplementation(async () => {
      n += 1;
      if (n === 1) return { id: "blk-1" };
      throw new AcuityError(422, "declined");
    });

    const res = await createGroup(mappedStaffId, [
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");

    // 🔴 Nobody is left booked - including the member whose block DID land.
    expect(await live()).toHaveLength(0);
    const group = await prisma.appointmentGroup.findFirst({ where: { shopId } });
    expect(group!.status).toBe("CANCELED");
  });

  it("the customer is never told they are booked", async () => {
    acuityMock.createBlock.mockRejectedValue(new AcuityError(422, "declined"));
    const res = await createGroup(mappedStaffId, [{ firstName: "Eric", serviceId: cutId }]);
    expect(res.status).not.toBe(201);
    expect(res.body.manageToken).toBeUndefined();
  });
});

describe("🔴 an unmapped chair on an ENFORCE shop refuses the booking", () => {
  it("creates nothing at all", async () => {
    // Without somewhere to write the block there is no way to protect the
    // time, and booking anyway is the unprotected write the whole mechanism
    // exists to prevent. The single-booking path refuses for the same reason.
    const res = await createGroup(unmappedStaffId, [
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    expect(await live()).toHaveLength(0);
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(0);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });
});

describe("an ambiguous response holds the booking rather than killing it", () => {
  it("answers 202 processing and keeps the party", async () => {
    // A 503 is "we never heard back". Cancelling would kill a real party over
    // a lost response AND strand live blocks; the reconciler settles it.
    acuityMock.createBlock.mockRejectedValue(new AcuityError(503, "down"));
    const res = await createGroup(mappedStaffId, [
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("processing");
    expect(await live()).toHaveLength(2);
  });
});

describe("a shop with mirroring OFF is untouched", () => {
  it("books the party and makes ZERO outbound calls", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    try {
      const res = await createGroup(mappedStaffId, [
        { firstName: "Eric", serviceId: cutId },
        { firstName: "Brother", serviceId: kidsId },
      ]);
      expect(res.status).toBe(201);
      expect(await live()).toHaveLength(2);
      // Not "few" - zero. A shop that has not opted in must never have its
      // barber's real Acuity calendar edited.
      expect(acuityMock.createBlock).not.toHaveBeenCalled();
      expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
    } finally {
      await prisma.shop.update({
        where: { id: shopId },
        data: { acuityOutboundMode: "ENFORCE" },
      });
    }
  });
});
