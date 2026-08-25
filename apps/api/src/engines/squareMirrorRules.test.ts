import { describe, expect, it } from "vitest";
import {
  classifySquareFailure,
  holdsTheChair,
  interpretBookingStatus,
  isSelfEcho,
  squareReleaseActor,
  isSquareMirrorEligible,
  isSquareSellerNote,
  squareSellerNoteOutboxId,
  shouldSquareObserve,
  squareSellerNote,
  totalOccupiedMinutes,
  type SquareMirrorShopSlice,
} from "./squareMirrorRules.js";

/**
 * The five decisions, proven branch by branch without a database or a network.
 *
 * Each of these fails against an implementation missing the specific rule it
 * names; none passes by accident.
 */

function shop(over: Partial<SquareMirrorShopSlice> = {}): SquareMirrorShopSlice {
  return {
    bookingMode: "native",
    squareOutboundMode: "ENFORCE",
    squareConnected: true,
    ...over,
  };
}

describe("isSquareMirrorEligible", () => {
  it("allows a create only for a connected, native, ENFORCING shop", () => {
    expect(isSquareMirrorEligible(shop(), "create")).toBe(true);
    expect(isSquareMirrorEligible(shop({ squareOutboundMode: "OBSERVE" }), "create")).toBe(false);
    expect(isSquareMirrorEligible(shop({ squareOutboundMode: "OFF" }), "create")).toBe(false);
    expect(isSquareMirrorEligible(shop({ bookingMode: "link" }), "create")).toBe(false);
    expect(isSquareMirrorEligible(shop({ squareConnected: false }), "create")).toBe(false);
  });

  it("allows a RELEASE in every mode, OFF included", () => {
    // A booking ChairBack created is ChairBack's to cancel. "We stopped
    // mirroring" must never mean "your Tuesday is booked solid forever with a
    // customer who does not exist".
    for (const mode of ["OFF", "OBSERVE", "ENFORCE"] as const) {
      expect(isSquareMirrorEligible(shop({ squareOutboundMode: mode }), "release")).toBe(true);
    }
  });

  it("refuses even a release once the connection is gone", () => {
    // There is nothing left to call.
    expect(isSquareMirrorEligible(shop({ squareConnected: false }), "release")).toBe(false);
  });

  it("marks OBSERVE as rehearsal, and nothing else as rehearsal", () => {
    expect(shouldSquareObserve(shop({ squareOutboundMode: "OBSERVE" }))).toBe(true);
    expect(shouldSquareObserve(shop())).toBe(false);
    expect(shouldSquareObserve(shop({ squareOutboundMode: "OFF" }))).toBe(false);
  });
});

describe("classifySquareFailure", () => {
  it("treats every proven rejection as definitive", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifySquareFailure(status)).toBe("definitive");
    }
  });

  it("treats anything that MIGHT have been processed as ambiguous", () => {
    // A timeout, a reset, a 429 or a 502 can all follow a request Square
    // actually handled. Compensating on those cancels a real appointment over
    // a lost response AND strands a live booking.
    expect(classifySquareFailure(null)).toBe("ambiguous");
    expect(classifySquareFailure(408)).toBe("ambiguous");
    expect(classifySquareFailure(429)).toBe("ambiguous");
    expect(classifySquareFailure(500)).toBe("ambiguous");
    expect(classifySquareFailure(502)).toBe("ambiguous");
    expect(classifySquareFailure(504)).toBe("ambiguous");
  });

  it("splits Square's 409 by CODE, because the status alone cannot", () => {
    // Square answers both "you sent a stale version" (safe to treat as final)
    // and idempotency-key contention on a request that may still be in flight
    // (not safe) with a 409.
    expect(classifySquareFailure(409, "VERSION_MISMATCH")).toBe("definitive");
    expect(classifySquareFailure(409, "BAD_REQUEST")).toBe("definitive");
    expect(classifySquareFailure(409, null)).toBe("ambiguous");
    expect(classifySquareFailure(409, "CONFLICT")).toBe("ambiguous");
  });
});

describe("interpretBookingStatus - did Square actually hold the chair?", () => {
  it("counts ONLY ACCEPTED as protection", () => {
    expect(interpretBookingStatus("ACCEPTED")).toBe("held");
    expect(holdsTheChair("ACCEPTED")).toBe(true);
  });

  it("does NOT count PENDING as protection", () => {
    // The booking exists; the chair does not. Square is waiting for the seller
    // to accept, and the slot stays bookable by anyone else until they do.
    expect(interpretBookingStatus("PENDING")).toBe("awaiting_seller");
    expect(holdsTheChair("PENDING")).toBe(false);
  });

  it("recognises every way a booking can free the time", () => {
    for (const s of [
      "CANCELLED_BY_CUSTOMER",
      "CANCELLED_BY_SELLER",
      "DECLINED",
      "NO_SHOW",
    ]) {
      expect(interpretBookingStatus(s)).toBe("released");
      expect(holdsTheChair(s)).toBe(false);
    }
  });

  it("treats an UNRECOGNISED status as not held", () => {
    // Under-claiming costs a line on a coverage report. Over-claiming costs a
    // double booking.
    expect(interpretBookingStatus("SOMETHING_NEW")).toBe("unknown");
    expect(interpretBookingStatus(null)).toBe("unknown");
    expect(interpretBookingStatus(undefined)).toBe("unknown");
    expect(holdsTheChair("SOMETHING_NEW")).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(holdsTheChair("  accepted ")).toBe(true);
  });
});

describe("the seller note", () => {
  it("carries an id and nothing about the customer", () => {
    const note = squareSellerNote("cmt123");
    expect(note).toBe("ChairBack ref cmt123");
    expect(isSquareSellerNote(note)).toBe(true);
    expect(isSquareSellerNote("Walk-in, cash")).toBe(false);
    expect(isSquareSellerNote(null)).toBe(false);
  });

  it("round-trips the outbox id back out of the note", () => {
    // This is the identifier that closes the create-to-webhook race: the note
    // exists before Square has ever seen the booking, and a live sandbox
    // delivery confirmed it comes back in the payload.
    expect(squareSellerNoteOutboxId(squareSellerNote("cmt123"))).toBe("cmt123");
  });

  it("returns null for anything that is not one of ours", () => {
    expect(squareSellerNoteOutboxId("Walk-in, cash")).toBeNull();
    expect(squareSellerNoteOutboxId(null)).toBeNull();
    expect(squareSellerNoteOutboxId(undefined)).toBeNull();
  });

  it("returns null for the prefix with no id after it", () => {
    // A barber typing the prefix alone must not resolve to a row, and an empty
    // string would otherwise sail into a findFirst as a wildcard-ish lookup.
    expect(squareSellerNoteOutboxId("ChairBack ref ")).toBeNull();
    expect(squareSellerNoteOutboxId("ChairBack ref    ")).toBeNull();
  });

  it("tolerates the whitespace a dashboard paste adds", () => {
    expect(squareSellerNoteOutboxId("  ChairBack ref cmt123  ")).toBe("cmt123");
  });
});

describe("squareReleaseActor - WHO freed the chair", () => {
  it("separates a customer cancellation from a seller one", () => {
    expect(squareReleaseActor("CANCELLED_BY_CUSTOMER")).toBe("customer");
    expect(squareReleaseActor("CANCELLED_BY_SELLER")).toBe("seller");
  });

  it("counts DECLINED as a seller action", () => {
    // The seller refused a booking request. Same actor class as cancelling.
    expect(squareReleaseActor("DECLINED")).toBe("seller");
  });

  it("keeps NO_SHOW distinct from any cancellation", () => {
    // Nobody cancelled - the client did not turn up. Filing it as a seller
    // cancel would put a customer-behaviour fact in a calendar-hygiene bucket.
    expect(squareReleaseActor("NO_SHOW")).toBe("no_show");
  });

  it("does not guess at an unrecognised status", () => {
    expect(squareReleaseActor("SOMETHING_NEW")).toBe("unknown");
    expect(squareReleaseActor(null)).toBe("unknown");
    expect(squareReleaseActor(undefined)).toBe("unknown");
  });

  it("is case- and whitespace-insensitive, like the status reader", () => {
    expect(squareReleaseActor("  cancelled_by_customer ")).toBe("customer");
  });
});

describe("isSelfEcho", () => {
  it("recognises a booking we own", () => {
    expect(isSelfEcho("BK_1", new Set(["BK_1", "BK_2"]))).toBe(true);
  });

  it("does not claim a booking the barber made", () => {
    expect(isSelfEcho("BK_9", new Set(["BK_1"]))).toBe(false);
    expect(isSelfEcho(null, new Set(["BK_1"]))).toBe(false);
  });
});

describe("totalOccupiedMinutes - the inbound correction", () => {
  it("adds EVERY segment, not just the first", () => {
    // The old code read segments[0] and under-stated a cut-plus-colour by an
    // hour, so ChairBack offered a slot the barber was still working through.
    expect(
      totalOccupiedMinutes([{ duration_minutes: 30 }, { duration_minutes: 60 }]),
    ).toBe(90);
  });

  it("includes the gap BETWEEN segments - the chair is busy through it", () => {
    expect(
      totalOccupiedMinutes([
        { duration_minutes: 20, intermission_minutes: 25 },
        { duration_minutes: 15 },
      ]),
    ).toBe(60);
  });

  it("returns NULL rather than guessing when a duration is missing", () => {
    // Null is not "use a default". It is the caller's signal to record a
    // sync-health error and block conservatively - guessing 30 minutes is what
    // put a customer in a chair that was still occupied.
    expect(totalOccupiedMinutes([{ duration_minutes: 30 }, {}])).toBeNull();
    expect(totalOccupiedMinutes([{ duration_minutes: null }])).toBeNull();
    expect(totalOccupiedMinutes([])).toBeNull();
    expect(totalOccupiedMinutes(null)).toBeNull();
    expect(totalOccupiedMinutes(undefined)).toBeNull();
  });

  it("rejects nonsense rather than propagating it", () => {
    expect(totalOccupiedMinutes([{ duration_minutes: -10 }])).toBeNull();
    expect(totalOccupiedMinutes([{ duration_minutes: Number.NaN }])).toBeNull();
    expect(totalOccupiedMinutes([{ duration_minutes: 0 }])).toBeNull();
  });
});
