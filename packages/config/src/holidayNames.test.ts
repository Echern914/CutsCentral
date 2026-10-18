import { describe, expect, it } from "vitest";
import { MAX_HOLIDAY_NAME, parseHolidayNames } from "./servicePricing";

describe("parseHolidayNames", () => {
  it("keeps real dates with a name, trimmed", () => {
    expect(parseHolidayNames({ "2026-11-26": "  Thanksgiving ", "2026-12-24": "Xmas Eve" })).toEqual({
      "2026-11-26": "Thanksgiving",
      "2026-12-24": "Xmas Eve",
    });
  });

  it("drops impossible dates, blank names, non-strings and non-objects", () => {
    expect(
      parseHolidayNames({
        "2026-02-30": "Nope",
        "2026-13-01": "Nope",
        "2026-12-25": "   ",
        "2026-12-26": 5,
        "2026-12-31": "NYE",
      }),
    ).toEqual({ "2026-12-31": "NYE" });
    expect(parseHolidayNames(null)).toEqual({});
    expect(parseHolidayNames(["2026-12-31"])).toEqual({});
  });

  it("cuts a long name to the cap", () => {
    const long = "x".repeat(MAX_HOLIDAY_NAME + 10);
    expect(parseHolidayNames({ "2026-12-31": long })["2026-12-31"]).toHaveLength(MAX_HOLIDAY_NAME);
  });
});
