import { describe, expect, it } from "vitest";
import {
  effectivePriceForDate,
  parsePriceOverrides,
  priceRangeForService,
} from "./pricing.js";

/** Pure day-of-week pricing helpers. */
describe("parsePriceOverrides", () => {
  it("keeps valid weekday->price entries", () => {
    expect(parsePriceOverrides({ "0": 55, "6": 60 })).toEqual({ 0: 55, 6: 60 });
  });
  it("drops out-of-range days, negatives, and junk", () => {
    expect(parsePriceOverrides({ "7": 10, "-1": 5, "0": -3, x: 9, "1": 45 })).toEqual({ 1: 45 });
  });
  it("coerces numeric strings, ignores non-objects", () => {
    expect(parsePriceOverrides({ "0": "55" })).toEqual({ 0: 55 });
    expect(parsePriceOverrides(null)).toEqual({});
    expect(parsePriceOverrides([1, 2])).toEqual({});
  });
});

describe("effectivePriceForDate", () => {
  // 2026-06-21 is a Sunday; 2026-06-22 is a Monday (UTC).
  const sunday = new Date("2026-06-21T15:00:00Z");
  const monday = new Date("2026-06-22T15:00:00Z");

  it("uses the weekday override when present (Sunday $55)", () => {
    expect(effectivePriceForDate(45, { "0": 55 }, sunday, "UTC")).toBe(55);
  });
  it("falls back to base on a non-overridden day (Monday $45)", () => {
    expect(effectivePriceForDate(45, { "0": 55 }, monday, "UTC")).toBe(45);
  });
  it("returns base when there are no overrides", () => {
    expect(effectivePriceForDate(45, {}, sunday, "UTC")).toBe(45);
  });
  it("returns null when no base price and no override for that day", () => {
    expect(effectivePriceForDate(null, { "0": 55 }, monday, "UTC")).toBeNull();
  });
  it("respects the shop timezone for the weekday boundary", () => {
    // 2026-06-22T02:00:00Z is Monday in UTC but still SUNDAY 22:00 in New York,
    // so a Sunday override must apply when the shop tz is New York.
    const lateSundayNy = new Date("2026-06-22T02:00:00Z");
    expect(effectivePriceForDate(45, { "0": 55 }, lateSundayNy, "America/New_York")).toBe(55);
    expect(effectivePriceForDate(45, { "0": 55 }, lateSundayNy, "UTC")).toBe(45);
  });
});

describe("priceRangeForService", () => {
  it("returns a single point when no overrides", () => {
    expect(priceRangeForService(45, {})).toEqual({ min: 45, max: 45 });
  });
  it("spans base and override values", () => {
    expect(priceRangeForService(45, { "0": 55 })).toEqual({ min: 45, max: 55 });
  });
  it("drops the base when every weekday is overridden", () => {
    const all = { "0": 60, "1": 45, "2": 45, "3": 45, "4": 45, "5": 45, "6": 50 };
    // base 45 is excluded since no day uses it; range is 45..60 from overrides.
    expect(priceRangeForService(99, all)).toEqual({ min: 45, max: 60 });
  });
  it("returns null when there is no price at all", () => {
    expect(priceRangeForService(null, {})).toBeNull();
  });
});
