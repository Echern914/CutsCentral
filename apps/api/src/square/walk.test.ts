import { describe, expect, it } from "vitest";
import type { ListParams } from "./client.js";
import type { SquareBooking } from "./types.js";
import { squareWindowSlices, walkSquareBookings } from "./walk.js";
import { SQUARE_MAX_RANGE_MS } from "./window.js";

/**
 * Pure paging contract — no DB, no HTTP. What's pinned here is the set of ways
 * a cursor walk goes wrong quietly:
 *   - asking Square for more than 31 days at once (it answers 400 - which is
 *     how every Square import and sweep failed until the walk sliced);
 *   - stopping after page 1 (the Acuity bug that made every sync cap at 100);
 *   - spinning forever on a server that keeps returning the same cursor;
 *   - abandoning a page because one booking in it blew up.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Square's documented limit on one ListBookings start-time range. */
const SQUARE_LIMIT_MS = 31 * DAY;

/**
 * A fake that behaves like Square where it matters: a range longer than 31
 * days is refused outright, the way production refused every request.
 * Otherwise it serves the bookings starting inside [min, max], paged.
 */
function squareLike(all: SquareBooking[]) {
  const calls: ListParams[] = [];
  return {
    calls,
    listBookings: async (p: ListParams) => {
      calls.push(p);
      const min = Date.parse(p.startAtMin!);
      const max = Date.parse(p.startAtMax!);
      if (max - min > SQUARE_LIMIT_MS) {
        throw Object.assign(new Error("Square 400 on /v2/bookings (BAD_REQUEST)"), {
          status: 400,
          code: "BAD_REQUEST",
        });
      }
      const inRange = all.filter((b) => {
        const t = Date.parse(b.start_at);
        return t >= min && t <= max;
      });
      const offset = p.cursor ? Number(p.cursor) : 0;
      const slice = inRange.slice(offset, offset + (p.limit ?? 100));
      const next = offset + slice.length;
      return { bookings: slice, cursor: next < inRange.length ? String(next) : null };
    },
  };
}

function bookingAt(id: string, startAt: string): SquareBooking {
  return { id, start_at: startAt, appointment_segments: [] } as unknown as SquareBooking;
}

describe("squareWindowSlices", () => {
  it("leaves a window Square accepts exactly as it was", () => {
    const min = "2026-08-01T00:00:00.000Z";
    const max = "2026-08-31T00:00:00.000Z";
    expect(squareWindowSlices(min, max)).toEqual([{ startAtMin: min, startAtMax: max }]);
  });

  it("🔴 cuts the connect-time window (2015 to a year ahead) into ranges Square accepts, newest first, with no gaps", () => {
    const min = "2015-01-01T00:00:00.000Z";
    const max = "2027-09-30T16:30:00.280Z";
    const slices = squareWindowSlices(min, max);

    expect(slices.length).toBeGreaterThan(150);
    for (const s of slices) {
      expect(Date.parse(s.startAtMax) - Date.parse(s.startAtMin)).toBeLessThanOrEqual(SQUARE_MAX_RANGE_MS);
      expect(Date.parse(s.startAtMax) - Date.parse(s.startAtMin)).toBeLessThanOrEqual(SQUARE_LIMIT_MS);
    }
    // Newest first, ending exactly at the window's own edges.
    expect(slices[0]!.startAtMax).toBe(max);
    expect(slices.at(-1)!.startAtMin).toBe(min);
    // Each slice starts no later than the next-newer one ends: every instant
    // of the window is inside some slice.
    for (let i = 1; i < slices.length; i++) {
      expect(Date.parse(slices[i]!.startAtMax)).toBeGreaterThan(Date.parse(slices[i - 1]!.startAtMin));
    }
  });

  it("covers the resync window (a week back, a year ahead) in thirteen slices", () => {
    const now = Date.parse("2026-09-30T16:30:00.000Z");
    const slices = squareWindowSlices(
      new Date(now - 7 * DAY).toISOString(),
      new Date(now + 365 * DAY).toISOString(),
    );
    expect(slices).toHaveLength(13);
  });
});

describe("walkSquareBookings over a long window", () => {
  it("🔴 never asks Square for more than 31 days, and brings in years of history", async () => {
    const all = [
      bookingAt("b2016", "2016-03-01T15:00:00Z"),
      bookingAt("b2022", "2022-07-19T14:30:00Z"),
      bookingAt("b2026", "2026-09-02T18:00:00Z"),
      bookingAt("bNext", "2027-03-10T15:00:00Z"),
    ];
    const square = squareLike(all);
    const seen: string[] = [];
    const res = await walkSquareBookings(
      square,
      { shopId: "shop1", startAtMin: "2015-01-01T00:00:00.000Z", startAtMax: "2027-09-30T00:00:00.000Z" },
      async (b) => {
        seen.push(b.id);
      },
    );
    expect(res.failed).toBe(0);
    expect(new Set(seen)).toEqual(new Set(["b2016", "b2022", "b2026", "bNext"]));
    // The newest slice is read first: what's booked ahead lands before history.
    expect(seen[0]).toBe("bNext");
    for (const c of square.calls) {
      expect(Date.parse(c.startAtMax!) - Date.parse(c.startAtMin!)).toBeLessThanOrEqual(SQUARE_LIMIT_MS);
    }
  });

  it("a booking exactly on a slice boundary is handled once, not twice and not never", async () => {
    const min = "2026-01-01T00:00:00.000Z";
    const max = "2026-04-01T00:00:00.000Z";
    const slices = squareWindowSlices(min, max);
    expect(slices.length).toBeGreaterThan(1);
    // Exactly where one slice starts - inside the minute the next one repeats.
    const edge = slices[0]!.startAtMin;
    const square = squareLike([bookingAt("edge", edge)]);
    const seen: string[] = [];
    const res = await walkSquareBookings(square, { shopId: "shop1", startAtMin: min, startAtMax: max }, async (b) => {
      seen.push(b.id);
    });
    expect(seen).toEqual(["edge"]);
    expect(res.handled).toBe(1);
  });

  it("the unsliced request is the one Square refuses (the failure this replaced)", async () => {
    const square = squareLike([]);
    await expect(
      square.listBookings({ startAtMin: "2015-01-01T00:00:00.000Z", startAtMax: "2027-09-30T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

function booking(id: string): SquareBooking {
  return {
    id,
    start_at: "2026-08-05T12:00:00Z",
    appointment_segments: [],
  } as unknown as SquareBooking;
}

/** A fake Square that serves `total` bookings in pages of 100. */
function pagedLister(total: number) {
  const all = Array.from({ length: total }, (_, i) => booking(`b${i + 1}`));
  const calls: ListParams[] = [];
  return {
    calls,
    listBookings: async (p: ListParams) => {
      calls.push(p);
      const offset = p.cursor ? Number(p.cursor) : 0;
      const limit = p.limit ?? 100;
      const slice = all.slice(offset, offset + limit);
      const nextOffset = offset + slice.length;
      return {
        bookings: slice,
        cursor: nextOffset < all.length ? String(nextOffset) : null,
      };
    },
  };
}

// One slice's worth (30 days): these cases are about paging within a slice.
const OPTS = {
  shopId: "shop1",
  locationId: "loc1",
  startAtMin: "2026-08-01T00:00:00Z",
  startAtMax: "2026-08-31T00:00:00Z",
};

describe("walkSquareBookings", () => {
  it("reads EVERY page, not just the first", async () => {
    const square = pagedLister(250);
    const seen: string[] = [];
    const res = await walkSquareBookings(square, OPTS, async (b) => {
      seen.push(b.id);
    });
    expect(res.handled).toBe(250);
    expect(res.pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250); // each exactly once
  });

  it("stops cleanly on a single short page", async () => {
    const square = pagedLister(7);
    const res = await walkSquareBookings(square, OPTS, async () => {});
    expect(res).toMatchObject({ handled: 7, pages: 1, failed: 0 });
  });

  it("handles an empty window without a second request", async () => {
    const square = pagedLister(0);
    const res = await walkSquareBookings(square, OPTS, async () => {});
    expect(res).toMatchObject({ handled: 0, pages: 1 });
    expect(square.calls).toHaveLength(1);
  });

  it("carries the window and location into every request", async () => {
    const square = pagedLister(150);
    await walkSquareBookings(square, OPTS, async () => {});
    expect(square.calls).toHaveLength(2);
    for (const c of square.calls) {
      expect(c.locationId).toBe("loc1");
      expect(c.startAtMin).toBe(OPTS.startAtMin);
      expect(c.startAtMax).toBe(OPTS.startAtMax);
      expect(c.limit).toBe(100);
    }
    // Page 2 must actually send the cursor page 1 returned.
    expect(square.calls[0]!.cursor).toBeNull();
    expect(square.calls[1]!.cursor).toBe("100");
  });

  it("gives up when the cursor stops advancing instead of looping", async () => {
    let calls = 0;
    const stuck = {
      listBookings: async () => {
        calls++;
        return { bookings: [booking("same")], cursor: "STUCK" };
      },
    };
    // First response sets cursor=STUCK; the second returns STUCK again, which
    // equals what we just sent -> stop. Without the check this runs to the cap.
    const res = await walkSquareBookings(stuck, OPTS, async () => {});
    expect(calls).toBe(2);
    expect(res.pages).toBe(2);
  });

  it("one bad booking does not abandon the rest of the page", async () => {
    const square = pagedLister(5);
    const ok: string[] = [];
    const res = await walkSquareBookings(square, OPTS, async (b) => {
      if (b.id === "b3") throw new Error("bad row");
      ok.push(b.id);
    });
    expect(res.handled).toBe(4);
    expect(res.failed).toBe(1);
    expect(ok).toEqual(["b1", "b2", "b4", "b5"]);
  });

  it("propagates a transport failure so the caller can mark the shop failed", async () => {
    const broken = {
      listBookings: async () => {
        throw new Error("401 unauthorized");
      },
    };
    await expect(walkSquareBookings(broken, OPTS, async () => {})).rejects.toThrow(
      "401 unauthorized",
    );
  });
});
