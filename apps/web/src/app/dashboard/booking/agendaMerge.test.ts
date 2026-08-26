import { describe, expect, it } from "vitest";
import { agendaWindowOf, mergeAgendaWindow } from "./agendaMerge";
import type { AgendaRow } from "./page";

/**
 * The calendar holds rows for every month the barber has paged to, but each
 * fetch answers for ONE window. These assert the half that was missing and the
 * half that would be dangerous to get wrong:
 *
 *   - RETRACTION: a row the server stopped listing has to disappear, or the
 *     barber's own cancel/unblock looks like it failed until a page reload;
 *   - WINDOW BOUND: retraction must never reach outside the fetched range, or
 *     paging back a month blanks it permanently (`loadedMonths` already counts
 *     it as loaded, so nothing refetches it).
 */

const JAN = "2026-01-15T14:00:00.000Z";
const FEB = "2026-02-15T14:00:00.000Z";
const WINDOW = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.000Z" };

function row(id: string, start: string, over: Partial<AgendaRow> = {}): AgendaRow {
  return {
    id,
    source: "appointment",
    start,
    end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    clientName: "Sam Reed",
    serviceName: "Skin Fade",
    serviceColor: null,
    price: 45,
    status: "upcoming",
    ...over,
  };
}

describe("mergeAgendaWindow", () => {
  it("retracts a row inside the window that the server no longer returns", () => {
    const prev = [row("a", JAN), row("b", JAN)];
    const out = mergeAgendaWindow(prev, [row("a", JAN)], WINDOW);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("KEEPS a row outside the window the response never spoke for", () => {
    // February row + a January response. The old additive merge kept it by
    // accident; a naive "delete what isn't listed" would wipe the month.
    const prev = [row("jan", JAN), row("feb", FEB)];
    const out = mergeAgendaWindow(prev, [row("jan", JAN)], WINDOW);
    expect(out.map((r) => r.id)).toEqual(["jan", "feb"]);
  });

  it("never retracts when the payload carries no window", () => {
    const prev = [row("a", JAN), row("b", JAN)];
    const out = mergeAgendaWindow(prev, [row("a", JAN)], {});
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("replaces a held row with the fresher one", () => {
    const prev = [row("a", JAN, { status: "upcoming", checkInStatus: null })];
    const fresh = row("a", JAN, { status: "upcoming", checkInStatus: "arrived" });
    const out = mergeAgendaWindow(prev, [fresh], WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.checkInStatus).toBe("arrived");
  });

  it("adds rows it has never seen", () => {
    const out = mergeAgendaWindow([row("a", JAN)], [row("a", JAN), row("b", JAN)], WINDOW);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("returns the SAME array reference when nothing moved", () => {
    // This is what stops the 20s poll re-rendering the whole day view forever.
    const prev = [row("a", JAN), row("b", JAN)];
    const out = mergeAgendaWindow(prev, [row("a", JAN), row("b", JAN)], WINDOW);
    expect(out).toBe(prev);
  });

  it("retracts a block that STARTS before the window but overlaps it", () => {
    // The API returns external blocks whose span merely intersects the range,
    // so an overnight block legitimately starts earlier. A start-only bound
    // would leave it on the calendar forever once removed in Acuity.
    const overnight = row("blk", "2025-12-31T22:00:00.000Z", {
      source: "block",
      end: "2026-01-01T06:00:00.000Z",
      status: "blocked",
    });
    const out = mergeAgendaWindow([overnight], [], WINDOW);
    expect(out).toEqual([]);
  });

  it("keeps a row whose span ends before the window opens", () => {
    const earlier = row("old", "2025-12-01T14:00:00.000Z");
    const out = mergeAgendaWindow([earlier], [], WINDOW);
    expect(out.map((r) => r.id)).toEqual(["old"]);
  });

  it("treats a money change as a change (the checkout must not stay stale)", () => {
    const prev = [row("a", JAN, { paid: null })];
    const out = mergeAgendaWindow(prev, [row("a", JAN, { paid: 45 })], WINDOW);
    expect(out).not.toBe(prev);
    expect(out[0]!.paid).toBe(45);
  });
});

describe("agendaWindowOf", () => {
  it("drops the window when the server truncated the answer", () => {
    // A capped response omits real rows. Retracting on that evidence would
    // delete bookings that still exist, so a truncated answer may only ADD.
    const win = agendaWindowOf(
      { from: WINDOW.from, to: WINDOW.to, truncated: true },
      WINDOW.from,
      WINDOW.to,
    );
    expect(win).toEqual({});

    const prev = [row("a", JAN), row("b", JAN)];
    expect(mergeAgendaWindow(prev, [row("a", JAN)], win)).toBe(prev);
  });

  it("prefers the window the server reports over the one requested", () => {
    // The API clamps oversized ranges (MAX_AGENDA_MS); trusting the request
    // would retract everything past the clamp.
    const win = agendaWindowOf(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
      "2026-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    );
    expect(win.to).toBe("2026-02-01T00:00:00.000Z");
  });

  it("falls back to the requested range for a payload with no window", () => {
    const win = agendaWindowOf({}, WINDOW.from, WINDOW.to);
    expect(win).toEqual({ from: WINDOW.from, to: WINDOW.to });
  });

  it("yields no window at all when neither side states one", () => {
    expect(agendaWindowOf({})).toEqual({ from: undefined, to: undefined });
  });
});
