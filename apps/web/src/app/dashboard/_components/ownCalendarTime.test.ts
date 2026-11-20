import { describe, expect, it } from "vitest";
import { addDays, blockSpanLabel, dayKeyIn, dayLabel, dollars, hhmmToMin, longDay, timeIn } from "./ownCalendarTime";

describe("own calendar date helpers", () => {
  it("steps a day key across a month, a year and a leap day", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // a US clock-change day
  });

  it("names a day relative to the shop's today", () => {
    expect(dayLabel("2026-11-20", "2026-11-20")).toBe("Today");
    expect(dayLabel("2026-11-21", "2026-11-20")).toBe("Tomorrow");
    expect(dayLabel("2026-11-19", "2026-11-20")).toBe("Yesterday");
    expect(dayLabel("2026-11-24", "2026-11-20")).toBe("Tue, Nov 24");
    expect(longDay("2026-11-24")).toBe("Tue, Nov 24");
  });

  it("reads an instant in the shop's zone, not the device's", () => {
    // 03:30 UTC on the 21st is still the evening of the 20th in New York.
    const iso = "2026-11-21T03:30:00.000Z";
    expect(timeIn("America/New_York", iso)).toBe("10:30 PM");
    expect(dayKeyIn("America/New_York", iso)).toBe("2026-11-20");
    expect(dayKeyIn("UTC", iso)).toBe("2026-11-21");
  });

  it("converts times and money", () => {
    expect(hhmmToMin("09:30")).toBe(570);
    expect(hhmmToMin("24:00")).toBe(1440);
    expect(dollars(4000)).toBe("$40");
    expect(dollars(4550)).toBe("$45.50");
  });

  it("labels a block for the one day being shown", () => {
    const tz = "UTC";
    expect(
      blockSpanLabel({ startsAt: "2026-11-24T13:00:00.000Z", endsAt: "2026-11-24T14:00:00.000Z" }, "2026-11-24", tz),
    ).toBe("1:00 PM to 2:00 PM");
    // A whole day.
    expect(
      blockSpanLabel({ startsAt: "2026-11-24T00:00:00.000Z", endsAt: "2026-11-25T00:00:00.000Z" }, "2026-11-24", tz),
    ).toBe("All day");
    // The middle day of a week away.
    expect(
      blockSpanLabel({ startsAt: "2026-11-23T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z" }, "2026-11-25", tz),
    ).toBe("All day");
    // The first day of an absence that starts at noon.
    expect(
      blockSpanLabel({ startsAt: "2026-11-24T12:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z" }, "2026-11-24", tz),
    ).toBe("12:00 PM to the end of the day");
    // Its last day, ending mid-afternoon.
    expect(
      blockSpanLabel({ startsAt: "2026-11-23T00:00:00.000Z", endsAt: "2026-11-25T15:00:00.000Z" }, "2026-11-25", tz),
    ).toBe("12:00 AM to 3:00 PM");
  });
});
