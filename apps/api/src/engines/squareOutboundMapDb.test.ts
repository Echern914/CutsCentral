import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  checkSquareBookingAllowed,
  getSquareSetupSnapshot,
  loadSquareConnectionRow,
  refreshSquareCapability,
  setOutboundLocation,
  setServiceVariation,
  setStaffTeamMember,
  SquareConnectionChangedError,
  TeamMemberNotOnAccountError,
  TeamMemberTakenError,
  VariationNotOnAccountError,
} from "./squareOutboundMap.js";

/**
 * The foundation guarantees that need a real database to prove:
 *
 *  1. ONE TEAM MEMBER, ONE CHAIR - enforced by a partial unique index, so it
 *     holds under a genuine concurrent race rather than only in the pre-check.
 *  2. ONE set of live reads per snapshot - two fetches can disagree and would
 *     show a "ready" badge above a list that no longer matches it.
 *  3. THE RECONNECT RACE - a mapping validated against authorization N must
 *     never be stamped fresh after the seller re-authorized as N+1, where the
 *     same team member id can be a stranger.
 *  4. The VERSION is captured server-side, never accepted from the caller.
 *  5. The booking guard answers from the DATABASE ALONE - the public booking
 *     path must not start failing because Square is down.
 */

const squareMock = vi.hoisted(() => ({
  getBooking: vi.fn(),
  listBookings: vi.fn(),
  getCustomer: vi.fn(),
  listLocations: vi.fn(async () => [
    { id: "L1", name: "Main St", status: "ACTIVE" },
    { id: "L2", name: "2nd Ave", status: "ACTIVE" },
  ]),
  getBusinessBookingProfile: vi.fn(async () => ({
    booking_enabled: true,
    support_seller_level_writes: true,
  })),
  listTeamMemberBookingProfiles: vi.fn(async () => [
    { team_member_id: "TM1", display_name: "Eric", is_bookable: true },
    { team_member_id: "TM2", display_name: "Sam", is_bookable: true },
    { team_member_id: "TM_OFF", display_name: "Not bookable", is_bookable: false },
  ]),
  listServiceCatalogItems: vi.fn(async () => [
    {
      id: "ITEM1",
      item_data: {
        name: "Haircut",
        product_type: "APPOINTMENTS_SERVICE",
        variations: [
          { id: "VAR1", version: 100, item_variation_data: { name: "30 min" } },
          { id: "VAR2", version: 200, item_variation_data: { name: "45 min" } },
        ],
      },
    },
  ]),
  getTokenStatus: vi.fn(async () => ({
    scopes: ["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE", "CUSTOMERS_READ"],
  })),
}));

vi.mock("../square/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../square/client.js")>();
  return { ...actual, getSquareClientForShop: vi.fn(async () => squareMock) };
});

let userId: string;
let shopId: string;
let otherShopId: string;
let staffA: string;
let staffB: string;
let serviceId: string;
let otherStaffId: string;
let otherServiceId: string;

async function makeShop(name: string): Promise<{ shopId: string; staffId: string; serviceId: string }> {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name,
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
  });
  await prisma.squareConnection.create({
    data: {
      shopId: shop.id,
      squareMerchantId: `M_${randomToken(6)}`,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const service = await prisma.service.create({
    data: { shopId: shop.id, name: "Fade", durationMin: 30, price: 40 },
  });
  const staff = await prisma.staff.create({ data: { shopId: shop.id, name: "Barber" } });
  await prisma.serviceStaff.create({
    data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
  });
  return { shopId: shop.id, staffId: staff.id, serviceId: service.id };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqmap-${randomToken(6)}@test.local`, passwordHash: "x", name: "S" },
  });
  userId = user.id;

  const main = await makeShop("Square Map Shop");
  shopId = main.shopId;
  staffA = main.staffId;
  serviceId = main.serviceId;
  const b = await prisma.staff.create({ data: { shopId, name: "Barber B" } });
  staffB = b.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId: staffB } });

  const other = await makeShop("Other Square Shop");
  otherShopId = other.shopId;
  otherStaffId = other.staffId;
  otherServiceId = other.serviceId;
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset every mapping so each test starts from a known, unmapped shop.
  for (const id of [shopId, otherShopId].filter(Boolean)) {
    await prisma.staff.updateMany({
      where: { shopId: id },
      data: {
        squareTeamMemberId: null,
        squareTeamMemberMappedAt: null,
        squareTeamMemberMappedGeneration: null,
      },
    });
    await prisma.service.updateMany({
      where: { shopId: id },
      data: {
        squareServiceVariationId: null,
        squareServiceVariationVersion: null,
        squareServiceVariationMappedAt: null,
        squareServiceVariationMappedGeneration: null,
      },
    });
    await prisma.squareConnection.updateMany({
      where: { shopId: id },
      data: {
        connectionGeneration: 1,
        outboundLocationId: null,
        outboundLocationName: null,
        outboundLocationGeneration: null,
        outboundLocationSelectedAt: null,
        grantedScopes: [],
        scopesCheckedAt: null,
        sellerLevelWrites: null,
        bookingEnabled: null,
        capabilityCheckedAt: null,
      },
    });
    await prisma.shop.update({ where: { id }, data: { squareOutboundMode: "OFF" } });
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  // 🔴 Every id is guarded. Prisma reads `{ shopId: undefined }` as NO FILTER,
  // not as "no match", so an unguarded cleanup after a failed beforeAll wipes
  // the shared test database and surfaces as failures in files nobody touched.
  const shopIds = [shopId, otherShopId].filter(Boolean);
  if (shopIds.length) {
    await prisma.serviceStaff.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.staff.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.service.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.squareConnection.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("setStaffTeamMember", () => {
  it("stores the id stamped with the CURRENT authorization generation", async () => {
    await setStaffTeamMember(shopId, staffA, "TM1", 1);
    const row = await prisma.staff.findUnique({ where: { id: staffA } });
    expect(row?.squareTeamMemberId).toBe("TM1");
    expect(row?.squareTeamMemberMappedGeneration).toBe(1);
    expect(row?.squareTeamMemberMappedAt).toBeInstanceOf(Date);
  });

  it("validates the id against the LIVE account, not against the request", async () => {
    // An id from a stale tab or another merchant aims a real booking at a
    // human being's day. It must not be storable.
    await expect(setStaffTeamMember(shopId, staffA, "TM_GHOST", 1)).rejects.toBeInstanceOf(
      TeamMemberNotOnAccountError,
    );
    const row = await prisma.staff.findUnique({ where: { id: staffA } });
    expect(row?.squareTeamMemberId).toBeNull();
  });

  it("refuses a team member Square says is NOT bookable", async () => {
    await expect(setStaffTeamMember(shopId, staffA, "TM_OFF", 1)).rejects.toBeInstanceOf(
      TeamMemberNotOnAccountError,
    );
  });

  it("refuses a save validated against a PREVIOUS authorization", async () => {
    // The seller reconnected between the list and the save. TM1 may be someone
    // else now, so the save is refused rather than stamped fresh.
    await prisma.squareConnection.update({
      where: { shopId },
      data: { connectionGeneration: 2 },
    });
    await expect(setStaffTeamMember(shopId, staffA, "TM1", 1)).rejects.toBeInstanceOf(
      SquareConnectionChangedError,
    );
  });

  it("refuses a save from a client that sent no generation at all", async () => {
    // An old client is an UNKNOWN generation, and unknown fails closed.
    await expect(setStaffTeamMember(shopId, staffA, "TM1", null)).rejects.toBeInstanceOf(
      SquareConnectionChangedError,
    );
  });

  it("refuses a save after the seller revoked us mid-flight", async () => {
    await prisma.squareConnection.update({ where: { shopId }, data: { revokedAt: new Date() } });
    await expect(setStaffTeamMember(shopId, staffA, "TM1", 1)).rejects.toBeInstanceOf(
      SquareConnectionChangedError,
    );
    await prisma.squareConnection.update({ where: { shopId }, data: { revokedAt: null } });
  });

  it("refuses a team member another chair in this shop already owns", async () => {
    await setStaffTeamMember(shopId, staffA, "TM1", 1);
    await expect(setStaffTeamMember(shopId, staffB, "TM1", 1)).rejects.toBeInstanceOf(
      TeamMemberTakenError,
    );
  });

  it("holds ONE TEAM MEMBER, ONE CHAIR under a real concurrent race", async () => {
    // The pre-check is a fast path; the partial unique index is the guarantee.
    // Both writers pass the pre-check here because neither has committed yet.
    const results = await Promise.allSettled([
      setStaffTeamMember(shopId, staffA, "TM2", 1),
      setStaffTeamMember(shopId, staffB, "TM2", 1),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);

    const holders = await prisma.staff.findMany({
      where: { shopId, squareTeamMemberId: "TM2" },
      select: { id: true },
    });
    expect(holders).toHaveLength(1);
  });

  it("clears a mapping without needing a generation", async () => {
    // Clearing can never point at the wrong person, and demanding a fresh
    // generation to UNDO a mapping would trap a shop after a reconnect.
    await setStaffTeamMember(shopId, staffA, "TM1", 1);
    await setStaffTeamMember(shopId, staffA, null, null);
    const row = await prisma.staff.findUnique({ where: { id: staffA } });
    expect(row?.squareTeamMemberId).toBeNull();
    expect(row?.squareTeamMemberMappedGeneration).toBeNull();
  });

  it("cannot map a chair belonging to another shop", async () => {
    await setStaffTeamMember(shopId, otherStaffId, "TM1", 1);
    const row = await prisma.staff.findUnique({ where: { id: otherStaffId } });
    expect(row?.squareTeamMemberId).toBeNull();
  });
});

describe("setServiceVariation", () => {
  it("captures the VERSION server-side from the same read that validated the id", async () => {
    await setServiceVariation(shopId, serviceId, "VAR1", 1);
    const row = await prisma.service.findUnique({ where: { id: serviceId } });
    expect(row?.squareServiceVariationId).toBe("VAR1");
    // 100 from the catalog, never anything the caller supplied - a version from
    // a stale browser tab would store a mapping that is already broken.
    expect(row?.squareServiceVariationVersion).toBe("100");
    expect(row?.squareServiceVariationMappedGeneration).toBe(1);
  });

  it("refuses a variation that is not in the seller's catalog", async () => {
    await expect(setServiceVariation(shopId, serviceId, "VAR_GHOST", 1)).rejects.toBeInstanceOf(
      VariationNotOnAccountError,
    );
  });

  it("refuses a save validated against a previous authorization", async () => {
    await prisma.squareConnection.update({ where: { shopId }, data: { connectionGeneration: 3 } });
    await expect(setServiceVariation(shopId, serviceId, "VAR1", 1)).rejects.toBeInstanceOf(
      SquareConnectionChangedError,
    );
  });

  it("ALLOWS two services to share one Square variation", async () => {
    // Unlike a team member, a variation is not a person. Two ChairBack services
    // priced as one Square service is a real shop, and nothing downstream
    // resolves backwards from a variation to a service.
    const second = await prisma.service.create({
      data: { shopId, name: "Fade + beard", durationMin: 45, price: 55 },
    });
    await setServiceVariation(shopId, serviceId, "VAR1", 1);
    await expect(setServiceVariation(shopId, second.id, "VAR1", 1)).resolves.toBeUndefined();
    await prisma.service.delete({ where: { id: second.id } });
  });

  it("cannot map a service belonging to another shop", async () => {
    await setServiceVariation(shopId, otherServiceId, "VAR1", 1);
    const row = await prisma.service.findUnique({ where: { id: otherServiceId } });
    expect(row?.squareServiceVariationId).toBeNull();
  });
});

describe("setOutboundLocation", () => {
  it("stores the chosen location with its name and generation", async () => {
    await setOutboundLocation(shopId, "L2", 1);
    const conn = await loadSquareConnectionRow(shopId);
    expect(conn.outboundLocationId).toBe("L2");
    expect(conn.outboundLocationName).toBe("2nd Ave");
    expect(conn.outboundLocationGeneration).toBe(1);
  });

  it("never defaults to the inbound 'first active location'", async () => {
    // squareLocationId was picked at connect time by "first ACTIVE" with nobody
    // looking. On a multi-location seller that would protect a chair in another
    // building, so outbound starts unset and stays unset until chosen.
    await prisma.squareConnection.update({
      where: { shopId },
      data: { squareLocationId: "L1" },
    });
    const conn = await loadSquareConnectionRow(shopId);
    expect(conn.outboundLocationId).toBeNull();
  });

  it("refuses a location that is not on the account", async () => {
    await expect(setOutboundLocation(shopId, "L_GHOST", 1)).rejects.toBeTruthy();
  });

  it("refuses a save validated against a previous authorization", async () => {
    await prisma.squareConnection.update({ where: { shopId }, data: { connectionGeneration: 4 } });
    await expect(setOutboundLocation(shopId, "L1", 1)).rejects.toBeInstanceOf(
      SquareConnectionChangedError,
    );
  });
});

describe("refreshSquareCapability", () => {
  it("persists the GRANTED scopes and the plan capability", async () => {
    await refreshSquareCapability(shopId);
    const conn = await loadSquareConnectionRow(shopId);
    expect(conn.grantedScopes).toEqual([
      "APPOINTMENTS_WRITE",
      "APPOINTMENTS_ALL_WRITE",
      "CUSTOMERS_READ",
    ]);
    expect(conn.scopesCheckedAt).toBeInstanceOf(Date);
    expect(conn.sellerLevelWrites).toBe(true);
    expect(conn.bookingEnabled).toBe(true);
    expect(conn.capabilityCheckedAt).toBeInstanceOf(Date);
  });

  it("persists a NEGATIVE capability - a plan downgrade must disarm the gate", async () => {
    squareMock.getBusinessBookingProfile.mockResolvedValueOnce({
      booking_enabled: true,
      support_seller_level_writes: false,
    });
    await refreshSquareCapability(shopId);
    expect((await loadSquareConnectionRow(shopId)).sellerLevelWrites).toBe(false);
  });

  it("leaves a good answer alone when the read fails", async () => {
    await refreshSquareCapability(shopId);
    squareMock.getTokenStatus.mockRejectedValueOnce(new Error("network"));
    squareMock.getBusinessBookingProfile.mockRejectedValueOnce(new Error("network"));
    await refreshSquareCapability(shopId);
    const conn = await loadSquareConnectionRow(shopId);
    // A Square outage must not erase what we knew five minutes ago.
    expect(conn.grantedScopes).toContain("APPOINTMENTS_ALL_WRITE");
    expect(conn.sellerLevelWrites).toBe(true);
  });

  it("does not throw for a shop with no Square connection", async () => {
    const bare = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "No Square",
        bookingUrl: `https://${randomToken(6)}.test`,
        webhookSecret: randomToken(),
      },
    });
    await expect(refreshSquareCapability(bare.id)).resolves.toBeUndefined();
    await prisma.shop.delete({ where: { id: bare.id } });
  });
});

describe("getSquareSetupSnapshot", () => {
  it("makes exactly ONE live read of each list", async () => {
    // Two fetches can disagree - a team member deactivated between them - and
    // would render a "ready" badge above a list that no longer matches it.
    await getSquareSetupSnapshot(shopId);
    expect(squareMock.listLocations).toHaveBeenCalledTimes(1);
    expect(squareMock.listTeamMemberBookingProfiles).toHaveBeenCalledTimes(1);
    expect(squareMock.listServiceCatalogItems).toHaveBeenCalledTimes(1);
  });

  it("reports a fully mapped shop as ready, and only then", async () => {
    let snap = await getSquareSetupSnapshot(shopId);
    expect(snap.readiness.ready).toBe(false);

    await refreshSquareCapability(shopId);
    await setOutboundLocation(shopId, "L1", 1);
    await setStaffTeamMember(shopId, staffA, "TM1", 1);
    await setStaffTeamMember(shopId, staffB, "TM2", 1);
    await setServiceVariation(shopId, serviceId, "VAR1", 1);

    snap = await getSquareSetupSnapshot(shopId);
    expect(snap.readiness.connectionProblems).toEqual([]);
    expect(snap.readiness.blockingPairs).toEqual([]);
    expect(snap.readiness.ready).toBe(true);
  });

  it("goes NOT ready the moment the seller re-authorizes", async () => {
    await refreshSquareCapability(shopId);
    await setOutboundLocation(shopId, "L1", 1);
    await setStaffTeamMember(shopId, staffA, "TM1", 1);
    await setStaffTeamMember(shopId, staffB, "TM2", 1);
    await setServiceVariation(shopId, serviceId, "VAR1", 1);
    expect((await getSquareSetupSnapshot(shopId)).readiness.ready).toBe(true);

    // Exactly what the OAuth callback does on a re-authorization.
    await prisma.squareConnection.update({
      where: { shopId },
      data: { connectionGeneration: { increment: 1 } },
    });

    const snap = await getSquareSetupSnapshot(shopId);
    expect(snap.readiness.ready).toBe(false);
    expect(snap.readiness.staff.map((s) => s.problem)).toEqual(["stale", "stale"]);
    expect(snap.readiness.connectionProblems).toContain("location_stale");
  });
});

describe("checkSquareBookingAllowed", () => {
  it("allows everything while the shop is OFF", async () => {
    expect(await checkSquareBookingAllowed(shopId, staffA, serviceId)).toBeNull();
  });

  it("allows everything while the shop is only OBSERVING", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "OBSERVE" } });
    expect(await checkSquareBookingAllowed(shopId, staffA, serviceId)).toBeNull();
  });

  it("refuses one unmapped barber under ENFORCE and lets the mapped one through", async () => {
    // The case the arming gate cannot cover: a barber hired after the shop was
    // armed. Refusing the whole shop would strip protection from everyone else.
    await refreshSquareCapability(shopId);
    await setOutboundLocation(shopId, "L1", 1);
    await setStaffTeamMember(shopId, staffA, "TM1", 1);
    await setServiceVariation(shopId, serviceId, "VAR1", 1);
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "ENFORCE" } });

    expect(await checkSquareBookingAllowed(shopId, staffA, serviceId)).toBeNull();
    expect(await checkSquareBookingAllowed(shopId, staffB, serviceId)).toBe(
      "square_staff_unmapped",
    );
  });

  it("makes NO Square call - the booking path must survive a Square outage", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "ENFORCE" } });
    vi.clearAllMocks();
    await checkSquareBookingAllowed(shopId, staffA, serviceId);
    expect(squareMock.listLocations).not.toHaveBeenCalled();
    expect(squareMock.listTeamMemberBookingProfiles).not.toHaveBeenCalled();
    expect(squareMock.listServiceCatalogItems).not.toHaveBeenCalled();
  });

  it("never lets one shop's mode refuse another shop's bookings", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { squareOutboundMode: "ENFORCE" } });
    expect(await checkSquareBookingAllowed(otherShopId, otherStaffId, otherServiceId)).toBeNull();
  });
});
