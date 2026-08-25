import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, SQUARE } from "@chairback/config";
import { createApp } from "../app.js";
import { buildAuthorizeUrl, createOAuthState, verifyOAuthState } from "../square/oauth.js";

/**
 * WHAT A CUSTOMER EXPERIENCES when a shop is armed and one chair is not mapped.
 *
 * ENFORCE cannot be SELECTED while any bookable pair is unmapped - but a barber
 * hired next Tuesday, or a service added next month, arrives into an
 * already-armed shop. There are only three possible answers and two of them are
 * wrong:
 *
 *   - take the booking anyway  -> sells time Square is still offering. This is
 *                                 the double-booking the feature exists to stop.
 *   - disarm the shop          -> strips protection from every barber who IS
 *                                 mapped, to accommodate the one who isn't.
 *   - refuse THAT PAIR only    -> what this file proves.
 *
 * Every Square call is mocked; the guard makes none of them.
 */
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
    { team_member_id: "TM1", display_name: "Mapped", is_bookable: true },
  ]),
  listServiceCatalogItems: vi.fn(async () => [
    {
      id: "ITEM1",
      item_data: {
        name: "Haircut",
        product_type: "APPOINTMENTS_SERVICE",
        variations: [{ id: "VAR1", version: 100, item_variation_data: { name: "30 min" } }],
      },
    },
  ]),
  getTokenStatus: vi.fn(async () => ({
    scopes: ["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE"],
  })),
}));

vi.mock("../square/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../square/client.js")>();
  return { ...actual, getSquareClientForShop: vi.fn(async () => squareMock) };
});

const app = createApp();
const password = "supersecret123";
let cookie: string;
let email: string;
let slug: string;
let shopId: string;
let mappedStaffId: string;
let newHireStaffId: string;
let serviceId: string;

/** A future instant well inside the booking window, on a fixed UTC hour. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function book(staffId: string, startsAt: Date) {
  return request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: startsAt.toISOString(),
    firstName: "Dana",
    lastName: "Okafor",
    phone: "(302) 555-0412",
    email: "dana0412@example.com",
    smsConsent: true,
  });
}

beforeAll(async () => {
  email = `sqguard-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Guard Op", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Guard Cuts", smsAttested: true });
  shopId = shop.body.id;
  slug = shop.body.slug;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 60 });

  const mapped = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Mapped Barber" });
  mappedStaffId = mapped.body.id;
  const hire = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "New Hire" });
  newHireStaffId = hire.body.id;

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({
      name: "Haircut",
      durationMin: 30,
      price: 35,
      staffIds: [mappedStaffId, newHireStaffId],
    });
  serviceId = service.body.id;

  // Open both chairs every day so availability is never the reason a booking
  // fails - the guard has to be the only thing that can refuse.
  for (const staffId of [mappedStaffId, newHireStaffId]) {
    const av = await request(app)
      .put(`/api/booking/staff/${staffId}/availability`)
      .set("Cookie", cookie)
      .send({
        rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMin: 8 * 60,
          endMin: 20 * 60,
        })),
      });
    expect(av.status).toBe(200);
  }

  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: `M_${randomToken(6)}`,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
      connectionGeneration: 1,
      grantedScopes: ["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE"],
      scopesCheckedAt: new Date(),
      sellerLevelWrites: true,
      bookingEnabled: true,
      capabilityCheckedAt: new Date(),
      outboundLocationId: "L1",
      outboundLocationName: "Main",
      outboundLocationGeneration: 1,
      outboundLocationSelectedAt: new Date(),
    },
  });
  // Only ONE of the two chairs is mapped. The service is.
  await prisma.staff.update({
    where: { id: mappedStaffId },
    data: {
      squareTeamMemberId: "TM1",
      squareTeamMemberMappedAt: new Date(),
      squareTeamMemberMappedGeneration: 1,
    },
  });
  await prisma.service.update({
    where: { id: serviceId },
    data: {
      squareServiceVariationId: "VAR1",
      squareServiceVariationVersion: "100",
      squareServiceVariationMappedAt: new Date(),
      squareServiceVariationMappedGeneration: 1,
    },
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

async function setMode(mode: "OFF" | "OBSERVE" | "ENFORCE"): Promise<void> {
  await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: mode } });
}

describe("public booking under Square ENFORCE", () => {
  it("takes the unmapped barber's bookings while the shop is OFF", async () => {
    await setMode("OFF");
    const res = await book(newHireStaffId, futureAtHour(3, 14));
    expect(res.status).toBe(201);
  });

  it("still takes them while the shop is only OBSERVING", async () => {
    // A rehearsal that quietly turns customers away is not a rehearsal.
    await setMode("OBSERVE");
    const res = await book(newHireStaffId, futureAtHour(4, 14));
    expect(res.status).toBe(201);
  });

  it("refuses the NEW HIRE under ENFORCE and keeps serving the mapped barber", async () => {
    await setMode("ENFORCE");

    const refused = await book(newHireStaffId, futureAtHour(5, 14));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("slot_unavailable_external");

    const served = await book(mappedStaffId, futureAtHour(5, 16));
    expect(served.status).toBe(201);

    // The refusal is a refusal, not a half-write.
    const appts = await prisma.appointment.findMany({
      where: { shopId },
      select: { staffId: true },
    });
    expect(appts.map((a) => a.staffId)).toEqual([mappedStaffId]);
  });

  it("refuses everyone when the SERVICE is the thing that is unmapped", async () => {
    await setMode("ENFORCE");
    await prisma.service.update({
      where: { id: serviceId },
      data: { squareServiceVariationId: null, squareServiceVariationMappedGeneration: null },
    });
    const res = await book(mappedStaffId, futureAtHour(6, 14));
    expect(res.status).toBe(409);

    await prisma.service.update({
      where: { id: serviceId },
      data: {
        squareServiceVariationId: "VAR1",
        squareServiceVariationVersion: "100",
        squareServiceVariationMappedGeneration: 1,
      },
    });
  });

  it("refuses a mapping that went stale on a re-authorization", async () => {
    // The id still exists. It just means a different person now.
    await setMode("ENFORCE");
    await prisma.squareConnection.update({
      where: { shopId },
      data: { connectionGeneration: { increment: 1 } },
    });
    const res = await book(mappedStaffId, futureAtHour(7, 14));
    expect(res.status).toBe(409);

    await prisma.squareConnection.update({
      where: { shopId },
      data: { connectionGeneration: 1 },
    });
  });

  it("makes no Square call while refusing - the booking page survives an outage", async () => {
    await setMode("ENFORCE");
    vi.clearAllMocks();
    await book(newHireStaffId, futureAtHour(8, 14));
    for (const fn of Object.values(squareMock)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the outbound OAuth scope is opt-in", () => {
  it("asks for READ-ONLY scopes on the ordinary connect", async () => {
    // Widening the default would change the consent screen every seller sees at
    // connect time, for a capability most of them cannot use.
    const url = buildAuthorizeUrl("state123");
    const scope = new URL(url).searchParams.get("scope") ?? "";
    expect(scope).toContain("APPOINTMENTS_ALL_READ");
    expect(scope).not.toContain("APPOINTMENTS_WRITE");
    expect(scope).not.toContain("APPOINTMENTS_ALL_WRITE");
  });

  it("asks for BOTH write scopes only when calendar protection is chosen", async () => {
    const url = buildAuthorizeUrl("state123", SQUARE.outboundScope);
    const scope = new URL(url).searchParams.get("scope") ?? "";
    for (const required of SQUARE.outboundRequiredScopes) expect(scope).toContain(required);
  });

  it("carries the choice in the SIGNED state, so the callback cannot be lied to", async () => {
    const now = Math.floor(Date.now() / 1000);
    const outbound = verifyOAuthState(createOAuthState("shop_1", now, true), now);
    expect(outbound?.outbound).toBe(true);

    const narrow = verifyOAuthState(createOAuthState("shop_1", now, false), now);
    expect(narrow?.outbound).toBeUndefined();
  });

  it("rejects a state whose outbound flag was tampered with", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createOAuthState("shop_1", now, false);
    const [payload, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    decoded.outbound = true;
    const forged = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${sig}`;
    expect(verifyOAuthState(forged, now)).toBeNull();
  });
});
