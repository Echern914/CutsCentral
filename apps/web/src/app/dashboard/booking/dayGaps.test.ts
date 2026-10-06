import { describe, expect, it } from "vitest";
import { clockLabel, firstOpenMinute, OPEN_MIN, type BusySpan } from "./dayGaps";

/**
 * ROOM INSIDE A BUSY HOUR. The case from the screenshot: 5:40-6:20 then
 * 6:20-6:30, so the 6 PM hour has room from 6:30.
 */

const at = (h: number, m = 0) => h * 60 + m;
const span = (staffId: string | null, from: number, to: number): BusySpan => ({
  staffId,
  startMin: from,
  endMin: to,
});

describe("firstOpenMinute", () => {
  it("🔴 the screenshot: a booking running in from 5 PM, then 6:20-6:30 - room from 6:30", () => {
    const busy = [span("sam", at(17, 40), at(18, 20)), span("sam", at(18, 20), at(18, 30))];
    expect(firstOpenMinute(busy, 18, ["sam"])).toBe(at(18, 30));
  });

  it("room BEFORE the first booking of the hour is offered first", () => {
    expect(firstOpenMinute([span("sam", at(14, 30), at(15, 0))], 14, ["sam"])).toBe(at(14, 0));
  });

  it("a full hour has no room", () => {
    const busy = [span("sam", at(19, 0), at(19, 30)), span("sam", at(19, 30), at(20, 0))];
    expect(firstOpenMinute(busy, 19, ["sam"])).toBeNull();
  });

  it(`a gap shorter than ${OPEN_MIN} minutes is not room`, () => {
    const busy = [span("sam", at(9, 0), at(9, 25)), span("sam", at(9, 30), at(10, 0))];
    expect(firstOpenMinute(busy, 9, ["sam"])).toBeNull();
    // ...and the last few minutes of an hour are not either.
    expect(firstOpenMinute([span("sam", at(9, 0), at(9, 55))], 9, ["sam"])).toBeNull();
  });

  it("a booking that runs through the whole hour from earlier leaves none", () => {
    expect(firstOpenMinute([span("sam", at(16, 30), at(18, 0))], 17, ["sam"])).toBeNull();
  });

  it("🔴 per chair: an hour full for one barber is still open for the other", () => {
    const busy = [span("sam", at(13, 0), at(14, 0)), span("ana", at(13, 0), at(13, 20))];
    expect(firstOpenMinute(busy, 13, ["sam", "ana"])).toBe(at(13, 20));
  });

  it("🔴 a row with no chair (a synced visit, an outside block) takes every chair", () => {
    const busy = [span(null, at(11, 0), at(12, 0)), span("sam", at(11, 0), at(11, 15))];
    expect(firstOpenMinute(busy, 11, ["sam", "ana"])).toBeNull();
  });

  it("with no barbers known, everything counts against one chair", () => {
    const busy = [span("x", at(10, 0), at(10, 20)), span("y", at(10, 20), at(10, 40))];
    expect(firstOpenMinute(busy, 10, [])).toBe(at(10, 40));
  });

  it("overlapping bookings are merged, not walked one at a time", () => {
    // A short booking inside a longer one does not open a gap at its end.
    const nested = [span("sam", at(15, 0), at(15, 45)), span("sam", at(15, 10), at(15, 20))];
    expect(firstOpenMinute(nested, 15, ["sam"])).toBe(at(15, 45));
    // Overlapping into the last minutes: 15:55-16:00 is too short.
    const overlapping = [span("sam", at(15, 0), at(15, 45)), span("sam", at(15, 30), at(15, 55))];
    expect(firstOpenMinute(overlapping, 15, ["sam"])).toBeNull();
  });
});

describe("clockLabel", () => {
  it("prints the way the planner does", () => {
    expect(clockLabel(at(18, 30))).toBe("6:30 PM");
    expect(clockLabel(at(0, 5))).toBe("12:05 AM");
    expect(clockLabel(at(12, 0))).toBe("12:00 PM");
    expect(clockLabel(at(9, 0))).toBe("9:00 AM");
  });
});
