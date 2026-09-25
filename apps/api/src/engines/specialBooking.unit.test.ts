import { describe, expect, it } from "vitest";
import { outsideRegularHours, specialNameSuffix } from "./specialBooking.js";

/**
 * "After hours" is a time fact about a special, judged against the barber's
 * regular weekly hours in the SHOP's timezone. Specials can be daytime ones,
 * so this is what keeps a 2 PM special from being called "After hours".
 */
const NINE_TO_FIVE = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMin: 9 * 60,
  endMin: 17 * 60,
}));

describe("outsideRegularHours", () => {
  it("an evening special is outside 9-5; an afternoon one is not", () => {
    expect(outsideRegularHours(new Date("2026-09-29T20:30:00Z"), "UTC", NINE_TO_FIVE)).toBe(true);
    expect(outsideRegularHours(new Date("2026-09-29T14:00:00Z"), "UTC", NINE_TO_FIVE)).toBe(false);
  });

  it("close is exclusive, open inclusive; before opening counts as outside", () => {
    expect(outsideRegularHours(new Date("2026-09-29T17:00:00Z"), "UTC", NINE_TO_FIVE)).toBe(true);
    expect(outsideRegularHours(new Date("2026-09-29T09:00:00Z"), "UTC", NINE_TO_FIVE)).toBe(false);
    expect(outsideRegularHours(new Date("2026-09-29T07:30:00Z"), "UTC", NINE_TO_FIVE)).toBe(true);
  });

  it("🔴 reads the SHOP's wall clock and weekday, not UTC's", () => {
    // Hours on Tuesday only (2026-09-29 is a Tuesday). 8:30 PM Tuesday in New
    // York is 00:30 UTC Wednesday - outside either way. 2 PM Tuesday in New
    // York is 18:00 UTC, which a UTC reading would wrongly call after hours.
    const tueOnly = [{ weekday: 2, startMin: 9 * 60, endMin: 17 * 60 }];
    expect(
      outsideRegularHours(new Date("2026-09-30T00:30:00Z"), "America/New_York", tueOnly),
    ).toBe(true);
    expect(
      outsideRegularHours(new Date("2026-09-29T18:00:00Z"), "America/New_York", tueOnly),
    ).toBe(false);
  });

  it("a day with no hours at all is outside them", () => {
    const weekdaysOnly = NINE_TO_FIVE.filter((r) => r.weekday >= 1 && r.weekday <= 5);
    // 2026-09-27 is a Sunday.
    expect(outsideRegularHours(new Date("2026-09-27T12:00:00Z"), "UTC", weekdaysOnly)).toBe(true);
  });

  it("a split day is judged by its envelope: between shifts is not 'after hours'", () => {
    const split = [
      { weekday: 2, startMin: 9 * 60, endMin: 12 * 60 },
      { weekday: 2, startMin: 18 * 60, endMin: 21 * 60 },
    ];
    expect(outsideRegularHours(new Date("2026-09-29T15:00:00Z"), "UTC", split)).toBe(false);
    expect(outsideRegularHours(new Date("2026-09-29T21:30:00Z"), "UTC", split)).toBe(true);
  });
});

describe("specialNameSuffix", () => {
  it("names what the booking is, and nothing for an ordinary one", () => {
    expect(specialNameSuffix({ special: true, afterHours: true })).toBe(" (After hours)");
    expect(specialNameSuffix({ special: true, afterHours: false })).toBe(" (Special)");
    expect(specialNameSuffix({ special: false, afterHours: false })).toBe("");
  });
});
