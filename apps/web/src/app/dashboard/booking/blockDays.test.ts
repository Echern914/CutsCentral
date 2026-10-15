import { describe, expect, it } from "vitest";
import { spreadAcrossDays } from "./blockDays";

/**
 * A block that runs past midnight shows on EVERY day it covers, each piece
 * clipped to that day's midnights in the SHOP's zone - including the night
 * the clocks change.
 */
const NY = "America/New_York";
const row = (start: string, end: string, source = "block") => ({ id: "b1", source, start, end });

describe("spreading a block across the days it covers", () => {
  it("leaves a block inside one day, and anything that is not a block, alone", () => {
    const lunch = row("2026-10-14T16:00:00.000Z", "2026-10-14T17:00:00.000Z");
    expect(spreadAcrossDays(lunch, NY)).toEqual([lunch]);
    // Ending exactly at the next midnight is still one day.
    const allDay = row("2026-10-14T04:00:00.000Z", "2026-10-15T04:00:00.000Z");
    expect(spreadAcrossDays(allDay, NY)).toEqual([allDay]);
    const cut = row("2026-10-14T16:00:00.000Z", "2026-10-16T17:00:00.000Z", "appointment");
    expect(spreadAcrossDays(cut, NY)).toEqual([cut]);
  });

  it("🔴 8 PM Wednesday through 8 AM Friday is three pieces, one per day, keeping the id", () => {
    // Wed Oct 14 20:00 EDT = Oct 15 00:00Z; Fri Oct 16 08:00 EDT = 12:00Z.
    const pieces = spreadAcrossDays(row("2026-10-15T00:00:00.000Z", "2026-10-16T12:00:00.000Z"), NY);
    expect(pieces.map((p) => [p.start, p.end])).toEqual([
      ["2026-10-15T00:00:00.000Z", "2026-10-15T04:00:00.000Z"], // Wed 8 PM - midnight
      ["2026-10-15T04:00:00.000Z", "2026-10-16T04:00:00.000Z"], // all of Thursday
      ["2026-10-16T04:00:00.000Z", "2026-10-16T12:00:00.000Z"], // Fri midnight - 8 AM
    ]);
    expect(pieces.every((p) => p.id === "b1")).toBe(true);
  });

  it("the night the clocks fall back is a 25-hour piece, not a day out of step", () => {
    // Sat Oct 31 12:00 EDT (16:00Z) through Mon Nov 2 12:00 EST (17:00Z).
    const pieces = spreadAcrossDays(row("2026-10-31T16:00:00.000Z", "2026-11-02T17:00:00.000Z"), NY);
    expect(pieces.map((p) => [p.start, p.end])).toEqual([
      ["2026-10-31T16:00:00.000Z", "2026-11-01T04:00:00.000Z"],
      ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"], // Sunday: 25 hours
      ["2026-11-02T05:00:00.000Z", "2026-11-02T17:00:00.000Z"],
    ]);
  });
});
