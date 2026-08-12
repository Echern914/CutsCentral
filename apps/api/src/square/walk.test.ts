import { describe, expect, it } from "vitest";
import type { ListParams } from "./client.js";
import type { SquareBooking } from "./types.js";
import { walkSquareBookings } from "./walk.js";

/**
 * Pure paging contract — no DB, no HTTP. What's pinned here is the set of ways
 * a cursor walk goes wrong quietly:
 *   - stopping after page 1 (the Acuity bug that made every sync cap at 100);
 *   - spinning forever on a server that keeps returning the same cursor;
 *   - abandoning a page because one booking in it blew up.
 */

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

const OPTS = {
  shopId: "shop1",
  locationId: "loc1",
  startAtMin: "2026-08-01T00:00:00Z",
  startAtMax: "2026-09-01T00:00:00Z",
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
