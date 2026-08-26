import { describe, expect, it } from "vitest";
import {
  computeSquareReadiness,
  hasOutboundScopes,
  indexServiceVariations,
  isSquareMappingStale,
  squareRefusalForBooking,
  type SquareConnectionRow,
  type SquareReadinessInput,
  type SquareServiceRow,
  type SquareStaffRow,
} from "./squareOutboundMap.js";
import type { SquareCatalogItem } from "../square/types.js";

/**
 * THE GATE, proven branch by branch.
 *
 * Everything here is pure - no database, no network - because this is the code
 * that decides whether ChairBack may write a real booking into a stranger's
 * Square calendar. Each test below fails against an implementation that is
 * missing the specific check it names; none of them passes by accident.
 */

const GEN = 7;

function connection(over: Partial<SquareConnectionRow> = {}): SquareConnectionRow {
  return {
    connected: true,
    revoked: false,
    generation: GEN,
    grantedScopes: ["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE"],
    scopesCheckedAt: new Date("2026-08-25T00:00:00Z"),
    sellerLevelWrites: true,
    bookingEnabled: true,
    capabilityCheckedAt: new Date("2026-08-25T00:00:00Z"),
    outboundLocationId: "L1",
    outboundLocationName: "Main",
    outboundLocationGeneration: GEN,
    ...over,
  };
}

function staff(over: Partial<SquareStaffRow> = {}): SquareStaffRow {
  return {
    id: "st1",
    name: "Eric",
    active: true,
    bookable: true,
    serviceIds: ["sv1"],
    squareTeamMemberId: "TM1",
    squareTeamMemberMappedAt: new Date(),
    squareTeamMemberMappedGeneration: GEN,
    ...over,
  };
}

function service(over: Partial<SquareServiceRow> = {}): SquareServiceRow {
  return {
    id: "sv1",
    name: "Fade",
    active: true,
    bookable: true,
    squareServiceVariationId: "VAR1",
    squareServiceVariationVersion: "100",
    squareServiceVariationMappedAt: new Date(),
    squareServiceVariationMappedGeneration: GEN,
    ...over,
  };
}

function input(over: Partial<SquareReadinessInput> = {}): SquareReadinessInput {
  return {
    staff: [staff()],
    services: [service()],
    connection: connection(),
    locations: [{ id: "L1", name: "Main", status: "ACTIVE" }],
    teamProfiles: [{ team_member_id: "TM1", display_name: "Eric C", is_bookable: true }],
    variations: [{ id: "VAR1", label: "Fade - 30 min", version: "100", serviceDurationMin: 30 }],
    ...over,
  };
}

describe("isSquareMappingStale", () => {
  it("treats a mapping stamped against the current generation as fresh", () => {
    expect(isSquareMappingStale(7, 7)).toBe(false);
  });

  it("treats a mapping from an older authorization as stale", () => {
    // The seller reconnected. Whoever holds TM1 on the new merchant is not
    // necessarily the person this chair was mapped to.
    expect(isSquareMappingStale(6, 7)).toBe(true);
  });

  it("treats a NEVER-STAMPED mapping as stale, not as fine", () => {
    // A row mapped before the column existed cannot prove which merchant it
    // referred to, and "we cannot prove it" must fail the same way as "we
    // proved it is wrong" when the cost is writing into a stranger's day.
    expect(isSquareMappingStale(null, 7)).toBe(true);
  });
});

describe("hasOutboundScopes", () => {
  it("requires BOTH write scopes", () => {
    // APPOINTMENTS_WRITE alone only manages bookings our own app created - the
    // exact READ/ALL_READ trap that under-synced the inbound integration.
    expect(hasOutboundScopes(["APPOINTMENTS_WRITE"])).toBe(false);
    expect(hasOutboundScopes(["APPOINTMENTS_ALL_WRITE"])).toBe(false);
    expect(hasOutboundScopes(["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE"])).toBe(true);
  });

  it("is case- and order-insensitive, and ignores unrelated scopes", () => {
    expect(
      hasOutboundScopes(["customers_read", "appointments_all_write", "APPOINTMENTS_WRITE"]),
    ).toBe(true);
  });

  it("is false for a read-only token - the state every existing connection is in", () => {
    expect(hasOutboundScopes(["APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"])).toBe(false);
  });
});

describe("indexServiceVariations", () => {
  const catalog: SquareCatalogItem[] = [
    {
      id: "ITEM1",
      type: "ITEM",
      item_data: {
        name: "Haircut",
        product_type: "APPOINTMENTS_SERVICE",
        variations: [
          {
            id: "VAR_A",
            version: 42,
            item_variation_data: { name: "30 min", service_duration: 1_800_000 },
          },
          { id: "VAR_B", version: "43", item_variation_data: { name: "60 min" } },
        ],
      },
    },
  ];

  it("flattens to VARIATIONS, which is what a booking can actually name", () => {
    // Offering the ITEM id would store something no Square booking can
    // reference - the create would fail at write time, on a real customer.
    const out = indexServiceVariations(catalog);
    expect(out.map((v) => v.id)).toEqual(["VAR_A", "VAR_B"]);
    expect(out[0]!.label).toBe("Haircut - 30 min");
  });

  it("carries the version as a string, whether Square sent a number or a string", () => {
    const out = indexServiceVariations(catalog);
    expect(out[0]!.version).toBe("42");
    expect(out[1]!.version).toBe("43");
  });

  it("converts Square's MILLISECOND service_duration to minutes", () => {
    expect(indexServiceVariations(catalog)[0]!.serviceDurationMin).toBe(30);
    expect(indexServiceVariations(catalog)[1]!.serviceDurationMin).toBeNull();
  });

  it("drops deleted items and deleted variations", () => {
    const withDeleted: SquareCatalogItem[] = [
      { id: "GONE", is_deleted: true, item_data: { product_type: "APPOINTMENTS_SERVICE", name: "X", variations: [{ id: "V" }] } },
      {
        id: "ITEM2",
        item_data: {
          name: "Beard",
          product_type: "APPOINTMENTS_SERVICE",
          variations: [{ id: "V_OK" }, { id: "V_GONE", is_deleted: true }],
        },
      },
    ];
    expect(indexServiceVariations(withDeleted).map((v) => v.id)).toEqual(["V_OK"]);
  });
});

describe("computeSquareReadiness - the connection gate", () => {
  it("is ready when everything lines up", () => {
    const r = computeSquareReadiness(input());
    expect(r.connectionProblems).toEqual([]);
    expect(r.blockingPairs).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("refuses a read-only token as reauth_required, not as unmapped", () => {
    // The distinction is the whole point: the fix is a re-authorization, not a
    // mapping. Every connection made before outbound existed is in this state.
    const r = computeSquareReadiness(
      input({ connection: connection({ grantedScopes: ["APPOINTMENTS_READ"] }) }),
    );
    expect(r.connectionProblems).toContain("reauth_required");
    expect(r.ready).toBe(false);
  });

  it("separates 'we could not ask' from 'the seller declined'", () => {
    const r = computeSquareReadiness(
      input({ connection: connection({ scopesCheckedAt: null, grantedScopes: [] }) }),
    );
    expect(r.connectionProblems).toContain("scopes_unverified");
    expect(r.connectionProblems).not.toContain("reauth_required");
    expect(r.ready).toBe(false);
  });

  it("refuses a seller plan that does not support seller-level writes", () => {
    const r = computeSquareReadiness(
      input({ connection: connection({ sellerLevelWrites: false }) }),
    );
    expect(r.connectionProblems).toContain("seller_writes_unsupported");
    expect(r.ready).toBe(false);
  });

  it("treats a capability Square did not report as UNSUPPORTED, never as supported", () => {
    // A missing field is the one place an optimistic default would arm a shop
    // whose every mirrored booking is going to be rejected.
    const r = computeSquareReadiness(
      input({ connection: connection({ sellerLevelWrites: null }) }),
    );
    expect(r.connectionProblems).toContain("seller_writes_unsupported");
    expect(r.ready).toBe(false);
  });

  it("distinguishes an UNREAD capability from a negative one", () => {
    const r = computeSquareReadiness(
      input({
        connection: connection({ capabilityCheckedAt: null, sellerLevelWrites: null }),
      }),
    );
    expect(r.connectionProblems).toContain("capability_unknown");
    expect(r.connectionProblems).not.toContain("seller_writes_unsupported");
  });

  it("refuses when the seller has switched their own online booking off", () => {
    const r = computeSquareReadiness(input({ connection: connection({ bookingEnabled: false }) }));
    expect(r.connectionProblems).toContain("booking_disabled");
    expect(r.ready).toBe(false);
  });

  it("refuses when no outbound location has been chosen", () => {
    // Never falls back to the "first ACTIVE location" the inbound connect
    // picked: on a multi-location seller that protects a chair in another
    // building.
    const r = computeSquareReadiness(
      input({ connection: connection({ outboundLocationId: null, outboundLocationGeneration: null }) }),
    );
    expect(r.connectionProblems).toContain("location_unset");
    expect(r.ready).toBe(false);
  });

  it("refuses a location chosen under a previous authorization", () => {
    const r = computeSquareReadiness(
      input({ connection: connection({ outboundLocationGeneration: GEN - 1 }) }),
    );
    expect(r.connectionProblems).toContain("location_stale");
    expect(r.ready).toBe(false);
  });

  it("refuses a location that is no longer on the account", () => {
    const r = computeSquareReadiness(input({ locations: [{ id: "L_OTHER", status: "ACTIVE" }] }));
    expect(r.connectionProblems).toContain("location_invalid");
    expect(r.ready).toBe(false);
  });

  it("refuses a disconnected shop without inventing mapping problems", () => {
    const r = computeSquareReadiness(input({ connection: connection({ connected: false }) }));
    expect(r.connectionProblems).toEqual(["not_connected"]);
    expect(r.ready).toBe(false);
  });

  it("reports a revoked authorization", () => {
    const r = computeSquareReadiness(input({ connection: connection({ revoked: true }) }));
    expect(r.connectionProblems).toContain("revoked");
    expect(r.ready).toBe(false);
  });

  it("preselects a location only when there is exactly one active one", () => {
    const unset = connection({ outboundLocationId: null, outboundLocationGeneration: null });
    expect(computeSquareReadiness(input({ connection: unset })).preselectLocationId).toBe("L1");
    expect(
      computeSquareReadiness(
        input({
          connection: unset,
          locations: [
            { id: "L1", status: "ACTIVE" },
            { id: "L2", status: "ACTIVE" },
          ],
        }),
      ).preselectLocationId,
    ).toBeNull();
  });
});

describe("computeSquareReadiness - mappings", () => {
  it("flags an unmapped chair and names the blocking PAIR", () => {
    const r = computeSquareReadiness(
      input({ staff: [staff({ squareTeamMemberId: null, squareTeamMemberMappedGeneration: null })] }),
    );
    expect(r.staff[0]!.problem).toBe("unmapped");
    expect(r.blockingPairs).toEqual([
      {
        staffId: "st1",
        staffName: "Eric",
        serviceId: "sv1",
        serviceName: "Fade",
        staffProblem: "unmapped",
        serviceProblem: null,
      },
    ]);
    expect(r.ready).toBe(false);
  });

  it("flags a chair mapped under a previous authorization as stale", () => {
    const r = computeSquareReadiness(
      input({ staff: [staff({ squareTeamMemberMappedGeneration: GEN - 1 })] }),
    );
    expect(r.staff[0]!.problem).toBe("stale");
    expect(r.ready).toBe(false);
  });

  it("flags a chair whose team member is gone from the account as invalid", () => {
    const r = computeSquareReadiness(input({ teamProfiles: [] }));
    expect(r.staff[0]!.problem).toBe("invalid");
    expect(r.ready).toBe(false);
  });

  it("treats a NON-BOOKABLE team member as invalid, not as mapped", () => {
    // Storing it would read valid on the setup screen and fail at write time.
    const r = computeSquareReadiness(
      input({ teamProfiles: [{ team_member_id: "TM1", display_name: "Eric", is_bookable: false }] }),
    );
    expect(r.staff[0]!.problem).toBe("invalid");
  });

  it("flags an unmapped SERVICE even when the barber is mapped perfectly", () => {
    // A perfectly mapped chair still cannot be protected for a service that is
    // not in the seller's catalog - which is why the unit is the PAIR.
    const r = computeSquareReadiness(
      input({
        services: [
          service({ squareServiceVariationId: null, squareServiceVariationMappedGeneration: null }),
        ],
      }),
    );
    expect(r.staff[0]!.problem).toBeNull();
    expect(r.services[0]!.problem).toBe("unmapped");
    expect(r.blockingPairs[0]).toMatchObject({ staffProblem: null, serviceProblem: "unmapped" });
    expect(r.ready).toBe(false);
  });

  it("flags a service whose catalog VERSION has moved", () => {
    // Square rejects a booking whose service_variation_version is behind the
    // catalog, so this mapping is a create that will definitely fail.
    const r = computeSquareReadiness(
      input({
        variations: [{ id: "VAR1", label: "Fade", version: "101", serviceDurationMin: 30 }],
      }),
    );
    expect(r.services[0]!.problem).toBe("version_stale");
    expect(r.services[0]!.liveVersion).toBe("101");
    expect(r.ready).toBe(false);
  });

  it("does not block on a chair that cannot receive a booking anyway", () => {
    // An inactive barber, or one offering no active service, has nothing to
    // mirror - demanding a mapping would hold the shop up for nothing.
    const r = computeSquareReadiness(
      input({
        staff: [
          staff(),
          staff({
            id: "st2",
            name: "Retired",
            active: false,
            bookable: false,
            squareTeamMemberId: null,
            squareTeamMemberMappedGeneration: null,
          }),
        ],
      }),
    );
    expect(r.blockingPairs).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("does not block on a service no active barber offers", () => {
    const r = computeSquareReadiness(
      input({
        services: [
          service(),
          service({
            id: "sv2",
            name: "Retired cut",
            bookable: false,
            squareServiceVariationId: null,
            squareServiceVariationMappedGeneration: null,
          }),
        ],
      }),
    );
    expect(r.blockingPairs).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("is NOT ready for a shop with no bookable pair at all", () => {
    // "Nothing to mirror" must not read as "fully protected" - arming here
    // would put a protected badge on a shop that protects nothing.
    const r = computeSquareReadiness(input({ staff: [], services: [] }));
    expect(r.ready).toBe(false);
    expect(r.blockingPairs).toEqual([]);
  });

  it("reports EVERY blocking pair, not just the first", () => {
    const r = computeSquareReadiness(
      input({
        staff: [
          staff({ id: "a", name: "A", serviceIds: ["sv1", "sv2"], squareTeamMemberId: null, squareTeamMemberMappedGeneration: null }),
          staff({ id: "b", name: "B", serviceIds: ["sv1"], squareTeamMemberId: "TM2", squareTeamMemberMappedGeneration: GEN }),
        ],
        services: [service(), service({ id: "sv2", name: "Beard", squareServiceVariationId: null, squareServiceVariationMappedGeneration: null })],
        teamProfiles: [
          { team_member_id: "TM1", is_bookable: true },
          { team_member_id: "TM2", is_bookable: true },
        ],
      }),
    );
    // A/Fade (staff unmapped), A/Beard (both), B/Fade is fine.
    expect(r.blockingPairs.map((p) => `${p.staffName}/${p.serviceName}`)).toEqual([
      "A/Fade",
      "A/Beard",
    ]);
  });
});

describe("squareRefusalForBooking - the per-pair booking guard", () => {
  const base = {
    mode: "ENFORCE" as const,
    connected: true,
    generation: GEN,
    outboundLocationId: "L1",
    outboundLocationGeneration: GEN,
    staffTeamMemberId: "TM1",
    staffMappedGeneration: GEN,
    serviceVariationId: "VAR1",
    serviceMappedGeneration: GEN,
  };

  it("allows a fully mapped pair", () => {
    expect(squareRefusalForBooking(base)).toBeNull();
  });

  it("NEVER refuses in OFF or OBSERVE", () => {
    // This is what makes OBSERVE a genuine rehearsal: it must not change one
    // thing a customer can book.
    const broken = { ...base, staffTeamMemberId: null, staffMappedGeneration: null };
    expect(squareRefusalForBooking({ ...broken, mode: "OFF" })).toBeNull();
    expect(squareRefusalForBooking({ ...broken, mode: "OBSERVE" })).toBeNull();
    expect(squareRefusalForBooking(broken)).toBe("square_staff_unmapped");
  });

  it("refuses a barber added after the shop was armed", () => {
    expect(
      squareRefusalForBooking({ ...base, staffTeamMemberId: null, staffMappedGeneration: null }),
    ).toBe("square_staff_unmapped");
  });

  it("refuses a service added after the shop was armed", () => {
    expect(
      squareRefusalForBooking({ ...base, serviceVariationId: null, serviceMappedGeneration: null }),
    ).toBe("square_service_unmapped");
  });

  it("refuses a mapping that went stale on a reconnect", () => {
    // The id still exists; it just means someone else now.
    expect(squareRefusalForBooking({ ...base, staffMappedGeneration: GEN - 1 })).toBe(
      "square_staff_unmapped",
    );
    expect(squareRefusalForBooking({ ...base, serviceMappedGeneration: GEN - 1 })).toBe(
      "square_service_unmapped",
    );
    expect(squareRefusalForBooking({ ...base, outboundLocationGeneration: GEN - 1 })).toBe(
      "square_location_unset",
    );
  });

  it("does not refuse a shop with no Square connection at all", () => {
    // An inbound-only shop that was never connected has nothing to mirror
    // into; refusing its bookings would break booking for a feature it does
    // not use.
    expect(
      squareRefusalForBooking({ ...base, connected: false, staffTeamMemberId: null }),
    ).toBeNull();
  });
});
