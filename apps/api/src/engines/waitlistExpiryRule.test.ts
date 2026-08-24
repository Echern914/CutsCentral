import { describe, expect, it } from "vitest";
import { entryIsExpired, windowIsPast, wallParts } from "./waitlistMatch.js";
import type { MatchWindow } from "./waitlistMatch.js";

/**
 * Waitlist phase F2: the rule that decides an entry is finished.
 *
 * Nothing here touches a database. What is pinned is the ONE promise the
 * sweeper rests on:
 *
 *   it may leave a dead entry alive, but it must never retire a live one.
 *
 * That asymmetry is deliberate. A person waiting a day longer than necessary
 * costs nothing; a person dropped a day early loses their place in a queue
 * that is ordered by when they joined, and no amount of apology puts them
 * back at the front.
 */

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

/** An instant, written as the wall clock of a zone - so the tests read the
 *  way the windows do. Verified against wallParts, never assumed. */
function at(iso: string): Date {
  return new Date(iso);
}

const win = (over: Partial<MatchWindow> = {}): MatchWindow => ({
  startDate: "2026-08-25",
  endDate: "2026-08-25",
  startMin: null,
  endMin: null,
  ...over,
});

const entry = (windows: MatchWindow[], over: Partial<{ timezone: string | null; minHoursNotice: number | null }> = {}) => ({
  timezone: null as string | null,
  minHoursNotice: null as number | null,
  windows,
  ...over,
});

const expired = (e: ReturnType<typeof entry>, now: Date, shopTimezone = NY) =>
  entryIsExpired(e, { shopTimezone, now });

// ───────────────────────────────────────────── the boundary

describe("the exact boundary", () => {
  const w = win({ startMin: 540, endMin: 1080 }); // 09:00-18:00 on 2026-08-25

  it("is alive one minute before the window closes", () => {
    // 17:59 EDT = 21:59 UTC
    expect(expired(entry([w]), at("2026-08-25T21:59:00Z"))).toBe(false);
  });

  it("is finished at the instant it closes, not a minute later", () => {
    // 18:00 EDT = 22:00 UTC
    expect(expired(entry([w]), at("2026-08-25T22:00:00Z"))).toBe(true);
  });

  it("an Any Time window runs to local midnight, not to 00:00", () => {
    const anyTime = win({ startMin: null, endMin: null });
    // 23:59 EDT on the 25th - still their day.
    expect(expired(entry([anyTime]), at("2026-08-26T03:59:00Z"))).toBe(false);
    // 00:00 EDT on the 26th.
    expect(expired(entry([anyTime]), at("2026-08-26T04:00:00Z"))).toBe(true);
  });

  it("a multi-day range is judged by its LAST day", () => {
    const range = win({ startDate: "2026-08-25", endDate: "2026-08-29", startMin: 540, endMin: 1080 });
    expect(expired(entry([range]), at("2026-08-26T22:00:00Z"))).toBe(false);
    expect(expired(entry([range]), at("2026-08-29T21:59:00Z"))).toBe(false);
    expect(expired(entry([range]), at("2026-08-29T22:00:00Z"))).toBe(true);
  });
});

describe("minimum notice", () => {
  const w = win({ startMin: 540, endMin: 1080 }); // closes 18:00 on the 25th

  it("48 hours of notice retires the entry 48 hours early", () => {
    // 18:00 on the 23rd + 48h = exactly the close.
    expect(expired(entry([w], { minHoursNotice: 48 }), at("2026-08-23T21:59:00Z"))).toBe(false);
    expect(expired(entry([w], { minHoursNotice: 48 }), at("2026-08-23T22:00:00Z"))).toBe(true);
  });

  it("a null notice behaves as zero, not as infinity", () => {
    expect(expired(entry([w], { minHoursNotice: null }), at("2026-08-25T21:59:00Z"))).toBe(false);
    expect(expired(entry([w], { minHoursNotice: null }), at("2026-08-25T22:00:00Z"))).toBe(true);
  });

  it("a negative notice is clamped, never used to extend a window", () => {
    expect(expired(entry([w], { minHoursNotice: -100 }), at("2026-08-25T22:00:00Z"))).toBe(true);
  });
});

describe("several windows", () => {
  it("🔴 four dead options and one live one keeps the entry", () => {
    const e = entry([
      win({ startDate: "2026-08-20", endDate: "2026-08-20" }),
      win({ startDate: "2026-08-21", endDate: "2026-08-21" }),
      win({ startDate: "2026-08-22", endDate: "2026-08-22" }),
      win({ startDate: "2026-08-23", endDate: "2026-08-23" }),
      win({ startDate: "2026-09-30", endDate: "2026-09-30" }), // still to come
    ]);
    expect(expired(e, at("2026-08-25T22:00:00Z"))).toBe(false);
  });

  it("all five dead retires it", () => {
    const e = entry(
      ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"].map((d) =>
        win({ startDate: d, endDate: d }),
      ),
    );
    expect(expired(e, at("2026-08-25T22:00:00Z"))).toBe(true);
  });
});

// ───────────────────────────────────────────── whose clock

describe("whose clock decides", () => {
  const w = win({ startDate: "2026-08-25", endDate: "2026-08-25", startMin: null, endMin: null });

  it("🔑 the customer's timezone wins over the shop's", () => {
    // 2026-08-25T16:00Z = 25th 12:00 in NY, but ALREADY the 26th 01:00 in
    // Tokyo. A Tokyo customer of a New York shop is finished; the shop's own
    // clock would have said otherwise for another twelve hours.
    const tokyo = entry([w], { timezone: TOKYO });
    expect(wallParts(at("2026-08-25T16:00:00Z"), TOKYO).date).toBe("2026-08-26");
    expect(expired(tokyo, at("2026-08-25T16:00:00Z"))).toBe(true);
    expect(expired(entry([w]), at("2026-08-25T16:00:00Z"))).toBe(false);
  });

  it("falls back to the shop when the entry has none", () => {
    expect(expired(entry([w], { timezone: null }), at("2026-08-26T03:59:00Z"))).toBe(false);
    expect(expired(entry([w], { timezone: null }), at("2026-08-26T04:00:00Z"))).toBe(true);
  });

  it("🔴 an invalid timezone falls back rather than throwing or expiring", () => {
    const junk = entry([w], { timezone: "Mars/Olympus_Mons" });
    expect(() => expired(junk, at("2026-08-26T03:59:00Z"))).not.toThrow();
    // Behaves exactly as the shop's own clock would.
    expect(expired(junk, at("2026-08-26T03:59:00Z"))).toBe(false);
    expect(expired(junk, at("2026-08-26T04:00:00Z"))).toBe(true);
  });
});

// ───────────────────────────────────────────── daylight saving

describe("daylight saving", () => {
  it("spring forward: the window dies when the clock jumps over it", () => {
    // 2027-03-14, New York: 02:00 EST becomes 03:00 EDT. 02:30 never happens.
    // A window ending 02:30 that day therefore has no last minute to reach -
    // the rule must not construct one, hang, or answer NaN.
    const w = win({ startDate: "2027-03-14", endDate: "2027-03-14", startMin: 0, endMin: 150 });
    const e = entry([w]);

    // 01:59 EST = 06:59 UTC - the last real minute before the jump.
    expect(wallParts(at("2027-03-14T06:59:00Z"), NY)).toEqual({ date: "2027-03-14", minutes: 119 });
    expect(expired(e, at("2027-03-14T06:59:00Z"))).toBe(false);

    // 03:00 EDT = 07:00 UTC - one minute later on the clock's own terms.
    expect(wallParts(at("2027-03-14T07:00:00Z"), NY)).toEqual({ date: "2027-03-14", minutes: 180 });
    expect(expired(e, at("2027-03-14T07:00:00Z"))).toBe(true);
  });

  it("🔴 fall back: the repeated hour does NOT retire the entry early", () => {
    // 2026-11-01, New York: 02:00 EDT becomes 01:00 EST, so 01:30 happens
    // TWICE - 05:30 UTC and again 06:30 UTC. A window ending 01:30 looks
    // finished at the first pass while a whole hour still inside it is yet
    // to come.
    const w = win({ startDate: "2026-11-01", endDate: "2026-11-01", startMin: 0, endMin: 90 });
    const e = entry([w]);

    // Both instants really are the same wall time.
    expect(wallParts(at("2026-11-01T05:30:00Z"), NY)).toEqual({ date: "2026-11-01", minutes: 90 });
    expect(wallParts(at("2026-11-01T06:30:00Z"), NY)).toEqual({ date: "2026-11-01", minutes: 90 });

    // FIRST 01:30 - a naive wall-clock rule retires here. It must not.
    expect(expired(e, at("2026-11-01T05:30:00Z"))).toBe(false);
    // Inside the fold, wall time has gone BACKWARDS to 01:00. Still alive -
    // and this is the hour a slot could still have been offered in.
    expect(wallParts(at("2026-11-01T06:00:00Z"), NY).minutes).toBe(60);
    expect(expired(e, at("2026-11-01T06:00:00Z"))).toBe(false);

    // SECOND 01:30, the fold is behind us - now it is genuinely over.
    expect(expired(e, at("2026-11-01T06:30:00Z"))).toBe(true);
  });

  it("the fold guard does not defer entries on an ordinary day", () => {
    // The guard only fires when the offset is about to move BACKWARDS. On
    // any normal evening the exact boundary is kept.
    const w = win({ startMin: 540, endMin: 1080 });
    expect(expired(entry([w]), at("2026-08-25T22:00:00Z"))).toBe(true);
  });
});

// ───────────────────────────────────────────── what must never expire

describe("what the sweeper must never touch", () => {
  it("🔴 a grandfathered legacy window has no end and never expires", () => {
    const legacy = entry([win({ startDate: null, endDate: null })]);
    // Years past any plausible horizon.
    expect(expired(legacy, at("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("🔴 an entry with NO windows never expires", () => {
    expect(expired(entry([]), at("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("one legacy window among dead ones keeps the whole entry alive", () => {
    const e = entry([
      win({ startDate: "2026-08-20", endDate: "2026-08-20" }),
      win({ startDate: null, endDate: null }),
    ]);
    expect(expired(e, at("2030-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("windowIsPast on its own", () => {
  const deadline = { date: "2026-08-25", minutes: 1080 }; // 18:00

  it("null endDate is never past - legacy is decided by F3, not here", () => {
    expect(windowIsPast(win({ startDate: null, endDate: null }), deadline)).toBe(false);
  });

  it("compares the date before the clock", () => {
    expect(windowIsPast(win({ endDate: "2026-08-24" }), deadline)).toBe(true);
    expect(windowIsPast(win({ endDate: "2026-08-26" }), deadline)).toBe(false);
  });

  it("on the last day, an absent endMin means midnight", () => {
    expect(windowIsPast(win({ endDate: "2026-08-25", endMin: null }), deadline)).toBe(false);
    expect(
      windowIsPast({ startDate: "2026-08-25", endDate: "2026-08-25", startMin: null, endMin: null }, { date: "2026-08-25", minutes: 1439 }),
    ).toBe(false);
  });

  it("is inclusive at the closing minute - end is exclusive, so 18:00 is over", () => {
    expect(windowIsPast(win({ endDate: "2026-08-25", endMin: 1080 }), deadline)).toBe(true);
    expect(windowIsPast(win({ endDate: "2026-08-25", endMin: 1081 }), deadline)).toBe(false);
  });
});
