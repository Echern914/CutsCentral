import { describe, expect, it } from "vitest";
import { dateHoursFor, isRealDateKey, parseDateHours, serializeDateHours } from "./pricing.js";

/**
 * Service.dateHours, read defensively. The one rule that matters most: a
 * damaged entry is DROPPED (the date stays on its usual hours) - it must never
 * read as "closed", because a closed day is a lost day of bookings.
 */
describe("parseDateHours", () => {
  it("keeps a good entry, in the engine's own shape", () => {
    const map = parseDateHours({ "2031-11-24": { w: [{ s: 480, e: 930 }, { s: 990, e: 1200 }], staff: ["a"] } });
    expect(map.get("2031-11-24")).toEqual({
      windows: [{ startMin: 480, endMin: 930 }, { startMin: 990, endMin: 1200 }],
      staffIds: ["a"],
    });
  });

  it("sorts windows and merges ones that touch or overlap", () => {
    const map = parseDateHours({ "2031-11-24": { w: [{ s: 600, e: 720 }, { s: 480, e: 600 }, { s: 700, e: 800 }] } });
    expect(map.get("2031-11-24")!.windows).toEqual([{ startMin: 480, endMin: 800 }]);
  });

  it("an entry written EMPTY is closed; one whose windows are all junk is dropped", () => {
    const map = parseDateHours({
      "2031-11-24": { w: [] },
      "2031-11-25": { w: [{ s: 900, e: 600 }, { s: "x", e: 10 }, null] },
    });
    expect(map.get("2031-11-24")).toEqual({ windows: [], staffIds: [] });
    expect(map.has("2031-11-25")).toBe(false);
  });

  it("drops a bad window but keeps the good ones beside it", () => {
    const map = parseDateHours({ "2031-11-24": { w: [{ s: 480, e: 600 }, { s: -5, e: 100 }, { s: 0, e: 1441 }] } });
    expect(map.get("2031-11-24")!.windows).toEqual([{ startMin: 480, endMin: 600 }]);
  });

  it("drops dates that do not exist and entries that are not entries", () => {
    const map = parseDateHours({
      "2031-02-30": { w: [] },
      "24-11-2031": { w: [] },
      "2031-11-24": "closed",
      "2031-11-25": [],
      "2031-11-26": { w: "08:00-10:00" },
      "2031-11-27": null,
    });
    expect(map.size).toBe(0);
  });

  it("anything that is not a map is no hours at all", () => {
    for (const raw of [null, undefined, [], "x", 3]) expect(parseDateHours(raw).size).toBe(0);
  });

  it("staff: junk ids dropped, duplicates collapsed, a non-list means everyone", () => {
    const map = parseDateHours({
      "2031-11-24": { w: [], staff: ["a", "a", "", 4, null, "b"] },
      "2031-11-25": { w: [], staff: "a" },
    });
    expect(map.get("2031-11-24")!.staffIds).toEqual(["a", "b"]);
    expect(map.get("2031-11-25")!.staffIds).toEqual([]);
  });

  it("round-trips through the stored shape, dates in order", () => {
    const stored = {
      "2031-11-25": { w: [{ s: 600, e: 660 }], staff: [] },
      "2031-11-24": { w: [], staff: ["a"] },
    };
    const out = serializeDateHours(parseDateHours(stored));
    expect(Object.keys(out)).toEqual(["2031-11-24", "2031-11-25"]);
    expect(out).toEqual(stored);
  });

  it("a name is kept, trimmed and capped; junk or blank is no name at all", () => {
    const map = parseDateHours({
      "2031-11-24": { w: [], staff: [], n: "  Long weekend " },
      "2031-11-25": { w: [], staff: [], n: "x".repeat(60) },
      "2031-11-26": { w: [], staff: [], n: "   " },
      "2031-11-27": { w: [], staff: [], n: 7 },
    });
    expect(map.get("2031-11-24")!.name).toBe("Long weekend");
    expect(map.get("2031-11-25")!.name).toBe("x".repeat(40));
    expect("name" in map.get("2031-11-26")!).toBe(false);
    expect("name" in map.get("2031-11-27")!).toBe(false);
  });

  it("a name round-trips, and an unnamed entry stores no name key", () => {
    const stored = {
      "2031-11-24": { w: [{ s: 480, e: 600 }], staff: [], n: "Long weekend" },
      "2031-11-25": { w: [], staff: ["a"] },
    };
    const out = serializeDateHours(parseDateHours(stored));
    expect(out).toEqual(stored);
    expect("n" in out["2031-11-25"]!).toBe(false);
  });

  it("a name changes nothing about the hours", () => {
    const named = parseDateHours({ "2031-11-24": { w: [{ s: 480, e: 600 }], staff: ["a"], n: "Long weekend" } });
    expect(dateHoursFor(named, "2031-11-24", "a")).toEqual([{ startMin: 480, endMin: 600 }]);
    expect(dateHoursFor(named, "2031-11-24", "b")).toBeNull();
  });
});

describe("dateHoursFor", () => {
  const map = parseDateHours({
    "2031-11-24": { w: [{ s: 480, e: 600 }] },
    "2031-11-25": { w: [{ s: 480, e: 600 }], staff: ["a"] },
    "2031-11-26": { w: [] },
  });

  it("null when the date has no entry - the usual week decides", () => {
    expect(dateHoursFor(map, "2031-11-23", "a")).toBeNull();
  });

  it("an entry naming nobody applies to everyone", () => {
    expect(dateHoursFor(map, "2031-11-24", "a")).toEqual([{ startMin: 480, endMin: 600 }]);
    expect(dateHoursFor(map, "2031-11-24", "z")).toEqual([{ startMin: 480, endMin: 600 }]);
  });

  it("an entry naming staff applies to them and to nobody else", () => {
    expect(dateHoursFor(map, "2031-11-25", "a")).toEqual([{ startMin: 480, endMin: 600 }]);
    expect(dateHoursFor(map, "2031-11-25", "b")).toBeNull();
    expect(dateHoursFor(map, "2031-11-25", null)).toBeNull();
  });

  it("closed is an empty list, not null", () => {
    expect(dateHoursFor(map, "2031-11-26", "a")).toEqual([]);
  });

  it("hands back a copy, so a caller cannot edit the parsed map", () => {
    const got = dateHoursFor(map, "2031-11-24", "a")!;
    got[0]!.endMin = 9999;
    expect(dateHoursFor(map, "2031-11-24", "a")).toEqual([{ startMin: 480, endMin: 600 }]);
  });
});

describe("isRealDateKey", () => {
  it("accepts real dates and refuses shapes and dates that do not exist", () => {
    expect(isRealDateKey("2032-02-29")).toBe(true); // leap year
    expect(isRealDateKey("2031-02-29")).toBe(false);
    expect(isRealDateKey("2031-13-01")).toBe(false);
    expect(isRealDateKey("2031-1-1")).toBe(false);
    expect(isRealDateKey("")).toBe(false);
  });
});
