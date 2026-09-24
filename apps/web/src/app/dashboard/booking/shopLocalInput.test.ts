import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { shopLocalInputValue } from "./shopLocalInput";

describe("shopLocalInputValue", () => {
  it("reads the instant in the SHOP's zone, not the device's", () => {
    // Fri Sep 25 2026, 8:00 PM in New York is 00:00 UTC on Sep 26.
    expect(shopLocalInputValue("2026-09-26T00:00:00.000Z", "America/New_York")).toBe(
      "2026-09-25T20:00",
    );
  });

  it("round-trips with the parse the picker's onChange uses", () => {
    const tz = "America/New_York";
    const iso = zonedWallTimeToUtc(2026, 8, 25, 20 * 60, tz).toISOString();
    expect(shopLocalInputValue(iso, tz)).toBe("2026-09-25T20:00");
  });

  it("uses a 24-hour clock with a zero hour at midnight", () => {
    const iso = zonedWallTimeToUtc(2026, 8, 25, 0, "America/New_York").toISOString();
    expect(shopLocalInputValue(iso, "America/New_York")).toBe("2026-09-25T00:00");
  });

  it("is empty rather than 'NaN' for a bad instant", () => {
    expect(shopLocalInputValue("not a date", "America/New_York")).toBe("");
  });
});
