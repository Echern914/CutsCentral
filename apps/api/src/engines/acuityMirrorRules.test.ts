/**
 * The three decisions that make outbound mirroring safe. Pure - no DB, no
 * network - because getting any of them wrong is worse than not mirroring:
 * a wrong eligibility answer writes to a stranger's calendar, a wrong
 * occupancy answer offers an occupied chair, and a wrong failure answer
 * cancels a real booking over a response we simply never received.
 */
import { describe, expect, it } from "vitest";
import {
  appointmentOccupiesTime,
  blockReference,
  classifyFailure,
  isMirrorEligible,
  isRecoveryMatch,
  matchesReference,
  shouldMirrorOnCreate,
  shouldObserve,
  type MirrorShopSlice,
  type OccupancySlice,
} from "./acuityMirrorRules.js";

const NOW = new Date("2026-08-25T21:00:00Z"); // 5:00 PM EDT

function shop(over: Partial<MirrorShopSlice> = {}): MirrorShopSlice {
  return {
    bookingMode: "native",
    acuityOutboundMode: "ENFORCE",
    acuityConnected: true,
    ...over,
  } as MirrorShopSlice;
}
function appt(over: Partial<OccupancySlice> = {}): OccupancySlice {
  return {
    status: "BOOKED",
    startsAt: new Date("2026-08-25T22:10:00Z"),
    endsAt: new Date("2026-08-25T22:30:00Z"),
    holdExpiresAt: null,
    visitId: null,
    ...over,
  };
}

describe("eligibility", () => {
  it("creates only for native + connected + ENFORCE", () => {
    expect(isMirrorEligible(shop(), "create")).toBe(true);
    expect(isMirrorEligible(shop({ acuityOutboundMode: "OBSERVE" }), "create")).toBe(false);
    expect(isMirrorEligible(shop({ acuityOutboundMode: "OFF" }), "create")).toBe(false);
    expect(isMirrorEligible(shop({ bookingMode: "acuity" }), "create")).toBe(false);
    expect(isMirrorEligible(shop({ acuityConnected: false }), "create")).toBe(false);
  });

  it("RELEASES in every mode - turning a shop OFF must never strand a live block", () => {
    for (const mode of ["OFF", "OBSERVE", "ENFORCE"] as const) {
      expect(isMirrorEligible(shop({ acuityOutboundMode: mode }), "release")).toBe(true);
    }
    // Even after the shop switched away from native booking.
    expect(isMirrorEligible(shop({ bookingMode: "link", acuityOutboundMode: "OFF" }), "release")).toBe(true);
  });

  it("cannot release without a connection - there is nothing to call", () => {
    expect(isMirrorEligible(shop({ acuityConnected: false }), "release")).toBe(false);
  });

  it("OBSERVE is its own state, distinct from both OFF and ENFORCE", () => {
    expect(shouldObserve(shop({ acuityOutboundMode: "OBSERVE" }))).toBe(true);
    expect(shouldObserve(shop({ acuityOutboundMode: "ENFORCE" }))).toBe(false);
    expect(shouldObserve(shop({ acuityOutboundMode: "OFF" }))).toBe(false);
  });
});

describe("occupancy", () => {
  it("a future BOOKED appointment occupies", () => {
    expect(appointmentOccupiesTime(appt(), NOW)).toBe(true);
  });

  it("a PENDING approval request occupies indefinitely", () => {
    expect(appointmentOccupiesTime(appt({ status: "PENDING" }), NOW)).toBe(true);
  });

  it("CANCELED and NO_SHOW free the chair", () => {
    expect(appointmentOccupiesTime(appt({ status: "CANCELED" }), NOW)).toBe(false);
    expect(appointmentOccupiesTime(appt({ status: "NO_SHOW" }), NOW)).toBe(false);
  });

  it("an appointment promoted from a synced Visit is Acuity's OWN booking - never mirrored back", () => {
    expect(appointmentOccupiesTime(appt({ visitId: "visit_1" }), NOW)).toBe(false);
    // ...even while it is plainly occupying the chair in ChairBack terms.
    expect(appointmentOccupiesTime(appt({ visitId: "visit_1", status: "BOOKED" }), NOW)).toBe(false);
  });

  it("AN IN-PROGRESS WALK-IN OCCUPIES, even though it is stored COMPLETED", () => {
    // Walk-ins are created COMPLETED at `now` (the money is already in the
    // till) but the client is in the chair for the service duration. Status
    // alone would call this free and offer the time in Acuity mid-cut.
    const walkIn = appt({
      status: "COMPLETED",
      startsAt: new Date(NOW.getTime() - 5 * 60_000),
      endsAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    expect(appointmentOccupiesTime(walkIn, NOW)).toBe(true);
  });

  it("once its span ends, a COMPLETED walk-in stops occupying", () => {
    const done = appt({
      status: "COMPLETED",
      startsAt: new Date(NOW.getTime() - 40 * 60_000),
      endsAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(appointmentOccupiesTime(done, NOW)).toBe(false);
  });

  it("a past BOOKED appointment does not occupy - the mirror never re-blocks yesterday", () => {
    expect(
      appointmentOccupiesTime(
        appt({ startsAt: new Date("2026-08-24T22:10:00Z"), endsAt: new Date("2026-08-24T22:30:00Z") }),
        NOW,
      ),
    ).toBe(false);
  });

  it("an EXPIRED receptionist hold does not occupy; a live one does", () => {
    const expired = appt({ status: "PENDING", holdExpiresAt: new Date(NOW.getTime() - 1000) });
    const live = appt({ status: "PENDING", holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000) });
    expect(appointmentOccupiesTime(expired, NOW)).toBe(false);
    expect(appointmentOccupiesTime(live, NOW)).toBe(true);
  });

  it("shouldMirrorOnCreate SKIPS ephemeral holds but mirrors indefinite requests", () => {
    const hold = appt({ status: "PENDING", holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000) });
    const request = appt({ status: "PENDING", holdExpiresAt: null });
    expect(shouldMirrorOnCreate(hold, NOW)).toBe(false);
    expect(shouldMirrorOnCreate(request, NOW)).toBe(true);
  });

  it("an appointment that ends exactly now is free (boundary, not overlap)", () => {
    expect(appointmentOccupiesTime(appt({ endsAt: NOW }), NOW)).toBe(false);
  });
});

describe("failure classification", () => {
  it("transport failure is AMBIGUOUS - no answer means the block may exist", () => {
    expect(classifyFailure(null)).toBe("ambiguous");
  });

  it("408, 429 and every 5xx are AMBIGUOUS", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(classifyFailure(s)).toBe("ambiguous");
    }
  });

  it("only a proven rejection is DEFINITIVE", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(classifyFailure(s)).toBe("definitive");
    }
  });

  it("an unrecognized 4xx defaults to AMBIGUOUS - failing closed on doubt", () => {
    expect(classifyFailure(418)).toBe("ambiguous");
    expect(classifyFailure(451)).toBe("ambiguous");
  });
});

describe("the opaque reference", () => {
  it("carries the outbox id and nothing else", () => {
    const ref = blockReference("outbox_abc123");
    expect(ref).toContain("outbox_abc123");
    // Visible in the barber's Acuity UI: no personal data, ever.
    expect(ref).not.toMatch(/@|\+\d|phone|email/i);
  });

  it("matches exactly, not loosely", () => {
    expect(matchesReference(blockReference("a1"), "a1")).toBe(true);
    expect(matchesReference(`${blockReference("a1")} extra`, "a1")).toBe(false);
    expect(matchesReference(blockReference("a11"), "a1")).toBe(false);
    expect(matchesReference(null, "a1")).toBe(false);
  });

  it("tolerates surrounding whitespace Acuity may add", () => {
    expect(matchesReference(`  ${blockReference("a1")}  `, "a1")).toBe(true);
  });
});

describe("ambiguous-create recovery matching", () => {
  const want = {
    outboxId: "ob_1",
    calendarId: "cal_9",
    startsAt: new Date("2026-08-25T22:10:00Z"),
    endsAt: new Date("2026-08-25T22:30:00Z"),
  };
  const candidate = {
    notes: blockReference("ob_1"),
    calendarID: "cal_9",
    startsAt: want.startsAt,
    endsAt: want.endsAt,
  };

  it("recovers on exact reference + calendar + span", () => {
    expect(isRecoveryMatch(candidate, want)).toBe(true);
  });

  it("reads the reference from `description` when Acuity puts it there", () => {
    expect(
      isRecoveryMatch({ ...candidate, notes: null, description: blockReference("ob_1") }, want),
    ).toBe(true);
  });

  it("refuses a same-span block on ANOTHER calendar", () => {
    expect(isRecoveryMatch({ ...candidate, calendarID: "cal_other" }, want)).toBe(false);
  });

  it("refuses a same-reference block at a DIFFERENT time (a stale/recycled note)", () => {
    expect(
      isRecoveryMatch({ ...candidate, endsAt: new Date("2026-08-25T23:00:00Z") }, want),
    ).toBe(false);
  });

  it("refuses another appointment's block sharing the exact span", () => {
    expect(isRecoveryMatch({ ...candidate, notes: blockReference("ob_2") }, want)).toBe(false);
  });

  it("refuses a barber's hand-made block with no reference at all", () => {
    expect(isRecoveryMatch({ ...candidate, notes: "lunch" }, want)).toBe(false);
    expect(isRecoveryMatch({ ...candidate, notes: null, description: null }, want)).toBe(false);
  });

  it("refuses when Acuity gave no parseable span", () => {
    expect(isRecoveryMatch({ ...candidate, startsAt: null, endsAt: null }, want)).toBe(false);
  });
});
