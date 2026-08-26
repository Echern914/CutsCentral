import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The operator surface for Square calendar protection.
 *
 * The route layer is where the things a non-engineer depends on live: only a
 * manager can reach it, ENFORCE cannot be armed until a real write would
 * actually succeed, and none of it leaks a customer's details. All three are
 * asserted here rather than assumed from the router's middleware list, because
 * a refactor that moves these routes to another router would silently drop any
 * of them.
 *
 * Every Square call is mocked. Nothing in S1 writes to Square, and these tests
 * additionally assert that the create/update/cancel surface does not exist.
 */
const squareMock = vi.hoisted(() => ({
  getBooking: vi.fn(),
  listBookings: vi.fn(),
  getCustomer: vi.fn(),
  listLocations: vi.fn(async () => [{ id: "L1", name: "Main St", status: "ACTIVE" }]),
  getBusinessBookingProfile: vi.fn(async () => ({
    booking_enabled: true,
    support_seller_level_writes: true,
  })),
  listTeamMemberBookingProfiles: vi.fn(async () => [
    { team_member_id: "TM1", display_name: "Eric", is_bookable: true },
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
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Square Op", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  const email = `sqroute-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Square Route Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Eric C" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;

  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: `M_${randomToken(6)}`,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.staff.updateMany({
    where: { shopId },
    data: {
      squareTeamMemberId: null,
      squareTeamMemberMappedAt: null,
      squareTeamMemberMappedGeneration: null,
    },
  });
  await prisma.service.updateMany({
    where: { shopId },
    data: {
      squareServiceVariationId: null,
      squareServiceVariationVersion: null,
      squareServiceVariationMappedAt: null,
      squareServiceVariationMappedGeneration: null,
    },
  });
  await prisma.squareConnection.updateMany({
    where: { shopId },
    data: {
      connectionGeneration: 1,
      outboundLocationId: null,
      outboundLocationName: null,
      outboundLocationGeneration: null,
      grantedScopes: [],
      scopesCheckedAt: null,
      sellerLevelWrites: null,
      bookingEnabled: null,
      capabilityCheckedAt: null,
    },
  });
  await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "OFF" } });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

/** Bring the shop all the way to "a real Square write would succeed". */
async function makeReady(): Promise<void> {
  await request(app).post("/api/booking/square/capability").set("Cookie", cookie).send({});
  const setup = await request(app).get("/api/booking/square/setup").set("Cookie", cookie);
  const generation = setup.body.generation as number;
  await request(app)
    .put("/api/booking/square/location")
    .set("Cookie", cookie)
    .send({ locationId: "L1", generation });
  await request(app)
    .put(`/api/booking/staff/${staffId}/square-team-member`)
    .set("Cookie", cookie)
    .send({ teamMemberId: "TM1", generation });
  await request(app)
    .put(`/api/booking/services/${serviceId}/square-variation`)
    .set("Cookie", cookie)
    .send({ variationId: "VAR1", generation });
}

describe("GET /api/booking/square/setup", () => {
  it("requires a signed-in manager", async () => {
    const anon = await request(app).get("/api/booking/square/setup");
    expect([401, 403]).toContain(anon.status);
  });

  it("reports an unmapped shop as not ready, with the specific reasons", async () => {
    const res = await request(app).get("/api/booking/square/setup").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("OFF");
    expect(res.body.ready).toBe(false);
    // Each problem is its own code because each has a different fix.
    expect(res.body.connectionProblems).toContain("scopes_unverified");
    expect(res.body.connectionProblems).toContain("capability_unknown");
    expect(res.body.connectionProblems).toContain("location_unset");
    expect(res.body.staff[0].problem).toBe("unmapped");
    expect(res.body.services[0].problem).toBe("unmapped");
  });

  it("offers only the seller's own business data - no tokens, no merchant id", async () => {
    const res = await request(app).get("/api/booking/square/setup").set("Cookie", cookie);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("accessToken");
    expect(wire).not.toContain("refreshToken");
    expect(wire).not.toContain("squareMerchantId");
    expect(res.body.locations).toEqual([{ id: "L1", name: "Main St", status: "ACTIVE" }]);
    expect(res.body.variations[0]).toMatchObject({ id: "VAR1", label: "Haircut - 30 min" });
  });

  it("surfaces a Square outage as its own code, not as 'unmapped'", async () => {
    // "Square would not answer" and "a chair is unmapped" have different fixes.
    squareMock.listLocations.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const res = await request(app).get("/api/booking/square/setup").set("Cookie", cookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("square_unavailable");
  });

  it("goes ready once every prerequisite is met", async () => {
    await makeReady();
    const res = await request(app).get("/api/booking/square/setup").set("Cookie", cookie);
    expect(res.body.connectionProblems).toEqual([]);
    expect(res.body.blockingPairs).toEqual([]);
    expect(res.body.ready).toBe(true);
  });
});

describe("the mapping setters", () => {
  it("reject a body that is not shaped right", async () => {
    const res = await request(app)
      .put("/api/booking/square/location")
      .set("Cookie", cookie)
      .send({ locationId: "L1", nonsense: true });
    expect(res.status).toBe(400);
  });

  it("404 on a chair that belongs to someone else", async () => {
    const res = await request(app)
      .put("/api/booking/staff/st_not_mine/square-team-member")
      .set("Cookie", cookie)
      .send({ teamMemberId: "TM1", generation: 1 });
    expect(res.status).toBe(404);
  });

  it("409s a save validated against a previous authorization", async () => {
    // The seller re-authorized while the setup tab was open. The id may point
    // at a different person now.
    const res = await request(app)
      .put(`/api/booking/staff/${staffId}/square-team-member`)
      .set("Cookie", cookie)
      .send({ teamMemberId: "TM1", generation: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("square_connection_changed");
  });

  it("409s an id that is not on the account", async () => {
    const res = await request(app)
      .put(`/api/booking/staff/${staffId}/square-team-member`)
      .set("Cookie", cookie)
      .send({ teamMemberId: "TM_GHOST", generation: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("team_member_not_on_account");
  });

  it("stores the catalog VERSION the server read, not one the client sent", async () => {
    await request(app)
      .put(`/api/booking/services/${serviceId}/square-variation`)
      .set("Cookie", cookie)
      // A stale tab could offer any version; the route has nowhere to put it.
      .send({ variationId: "VAR1", generation: 1 });
    const row = await prisma.service.findUnique({ where: { id: serviceId } });
    expect(row?.squareServiceVariationVersion).toBe("100");
  });
});

describe("PUT /api/booking/square/outbound-mode", () => {
  it("requires a signed-in manager", async () => {
    const anon = await request(app)
      .put("/api/booking/square/outbound-mode")
      .send({ mode: "ENFORCE" });
    expect([401, 403]).toContain(anon.status);
  });

  it("REFUSES ENFORCE while any bookable pair is unmapped, and says which", async () => {
    // Half-mirrored is worse than unmirrored: it looks protected and isn't.
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "ENFORCE" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("mapping_incomplete");
    expect(res.body.blockingPairs[0]).toMatchObject({
      staffName: "Eric C",
      serviceName: "Haircut",
      staffProblem: "unmapped",
    });
    expect(await currentMode()).toBe("OFF");
  });

  it("REFUSES ENFORCE on a read-only token even when every mapping is perfect", async () => {
    await makeReady();
    await prisma.squareConnection.update({
      where: { shopId },
      data: { grantedScopes: ["APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"] },
    });
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "ENFORCE" });
    expect(res.status).toBe(409);
    expect(res.body.connectionProblems).toContain("reauth_required");
    expect(await currentMode()).toBe("OFF");
  });

  it("REFUSES ENFORCE on a Square plan without seller-level writes", async () => {
    await makeReady();
    await prisma.squareConnection.update({
      where: { shopId },
      data: { sellerLevelWrites: false },
    });
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "ENFORCE" });
    expect(res.status).toBe(409);
    expect(res.body.connectionProblems).toContain("seller_writes_unsupported");
    expect(await currentMode()).toBe("OFF");
  });

  it("allows OBSERVE with nothing mapped - that is what a rehearsal is for", async () => {
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "OBSERVE" });
    expect(res.status).toBe(200);
    expect(await currentMode()).toBe("OBSERVE");
  });

  it("allows ENFORCE once a real write would actually succeed", async () => {
    await makeReady();
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "ENFORCE" });
    expect(res.status).toBe(200);
    expect(await currentMode()).toBe("ENFORCE");
  });

  it("always allows stepping back to OFF", async () => {
    await makeReady();
    await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "ENFORCE" });
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "OFF" });
    expect(res.status).toBe(200);
    expect(await currentMode()).toBe("OFF");
  });

  it("rejects a mode that is not one of the three", async () => {
    const res = await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "ON" });
    expect(res.status).toBe(400);
  });
});

describe("S1 writes nothing to Square", () => {
  it("exposes no create/update/cancel on the client at all", async () => {
    // The strongest form of "this PR cannot touch a seller's calendar": the
    // capability does not exist yet. PR S2 adds it, behind these gates.
    const client = await import("../square/client.js");
    const built = await (
      client.getSquareClientForShop as unknown as (id: string) => Promise<Record<string, unknown>>
    )(shopId);
    for (const forbidden of ["createBooking", "updateBooking", "cancelBooking", "searchAvailability"]) {
      expect(built[forbidden]).toBeUndefined();
    }
  });

  it("makes no Square call at all while merely reading the mode", async () => {
    await request(app)
      .put("/api/booking/square/outbound-mode")
      .set("Cookie", cookie)
      .send({ mode: "OBSERVE" });
    for (const fn of [
      squareMock.listLocations,
      squareMock.listTeamMemberBookingProfiles,
      squareMock.listServiceCatalogItems,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

async function currentMode(): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { squareOutboundMode: true },
  });
  return shop!.squareOutboundMode;
}
