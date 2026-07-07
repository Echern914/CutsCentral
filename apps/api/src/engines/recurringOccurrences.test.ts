import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "@chairback/config";
import { computeOccurrences, MAX_OCCURRENCES } from "./recurringSeries.js";

/**
 * Pure DST-correctness tests for the occurrence generator (no DB). The whole
 * point of storing the rule shop-local and recomputing each instant: a weekly
 * "9:00 Tuesday" must stay 9:00 LOCAL across a DST boundary, even though its UTC
 * hour shifts by one. Naively adding 7*24h in UTC would silently drift it.
 */

const TZ = "America/New_York";

function localHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(at),
  ) % 24;
}
function localParts(at: Date) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { hour: Number(g("hour")) % 24, minute: Number(g("minute")) };
}

describe("computeOccurrences", () => {
  it("generates `count` weekly occurrences 7 local days apart", () => {
    // Tue Feb 24 2026, 09:00 local (winter/EST).
    const anchor = zonedWallTimeToUtc(2026, 1, 24, 540, TZ);
    const occ = computeOccurrences({ interval: 1, weekday: 2, startMin: 540, count: 4 }, anchor, TZ);
    expect(occ.length).toBe(4);
    // Every occurrence is 09:00 local and a Tuesday.
    for (const o of occ) {
      expect(localHour(o.startsAt)).toBe(9);
      expect(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(o.startsAt)).toBe("Tue");
    }
    // Spacing is 7 calendar days (occurrence 1 = Mar 3).
    expect(occ[1]!.startsAt.getTime() - occ[0]!.startsAt.getTime()).toBe(7 * 24 * 3600_000);
  });

  it("keeps local 09:00 across the spring-forward boundary (UTC hour shifts)", () => {
    // Anchor Tue Feb 24 (EST) → series crosses Mar 8 spring-forward.
    const anchor = zonedWallTimeToUtc(2026, 1, 24, 540, TZ);
    const occ = computeOccurrences({ interval: 1, weekday: 2, startMin: 540, count: 4 }, anchor, TZ);
    // All four stay at local 09:00 …
    for (const o of occ) expect(localParts(o.startsAt)).toEqual({ hour: 9, minute: 0 });
    // … but the UTC hour changes across the boundary: EST occurrences are 14:00Z,
    // post-spring-forward (EDT) occurrences are 13:00Z. Prove both appear.
    const utcHours = occ.map((o) => o.startsAt.getUTCHours());
    expect(utcHours).toContain(14); // before Mar 8 (EST)
    expect(utcHours).toContain(13); // on/after Mar 8 (EDT)
  });

  it("honors every-N-weeks intervals (14 LOCAL days apart, DST-safe)", () => {
    // Anchor in summer (EDT) so the pair stays in one DST regime — a clean UTC
    // delta. (Across spring-forward the local time is preserved so the UTC delta
    // is intentionally 14d ± 1h; that DST-preservation is covered above.)
    const anchor = zonedWallTimeToUtc(2026, 5, 2, 600, TZ); // Tue Jun 2 10:00 EDT
    const occ = computeOccurrences({ interval: 2, weekday: 2, startMin: 600, count: 3 }, anchor, TZ);
    expect(occ.length).toBe(3);
    // Same summer regime → exactly 14×24h apart, and local time stays 10:00.
    expect(occ[1]!.startsAt.getTime() - occ[0]!.startsAt.getTime()).toBe(14 * 24 * 3600_000);
    for (const o of occ) expect(localParts(o.startsAt)).toEqual({ hour: 10, minute: 0 });
  });

  it("terminates at untilDate (inclusive of that day)", () => {
    const anchor = zonedWallTimeToUtc(2026, 1, 24, 540, TZ);
    // Until Mar 10 end-of-day → occurrences Feb 24, Mar 3, Mar 10 (3 total).
    const untilDate = zonedWallTimeToUtc(2026, 2, 10, 1439, TZ);
    const occ = computeOccurrences({ interval: 1, weekday: 2, startMin: 540, untilDate }, anchor, TZ);
    expect(occ.length).toBe(3);
    expect(occ[occ.length - 1]!.startsAt.getUTCMonth()).toBe(2); // March
    expect(occ[occ.length - 1]!.startsAt.getUTCDate()).toBe(10);
  });

  it("hard-caps runaway series at MAX_OCCURRENCES", () => {
    const anchor = zonedWallTimeToUtc(2026, 1, 24, 540, TZ);
    const occ = computeOccurrences({ interval: 1, weekday: 2, startMin: 540, count: 999 }, anchor, TZ);
    expect(occ.length).toBe(MAX_OCCURRENCES);
  });

  it("is 0-indexed with contiguous indices", () => {
    const anchor = zonedWallTimeToUtc(2026, 1, 24, 540, TZ);
    const occ = computeOccurrences({ interval: 1, weekday: 2, startMin: 540, count: 3 }, anchor, TZ);
    expect(occ.map((o) => o.index)).toEqual([0, 1, 2]);
  });
});
