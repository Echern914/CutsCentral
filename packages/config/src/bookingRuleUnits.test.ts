import { describe, expect, it } from "vitest";
import {
  BOOKING_LEAD_MAX_MINUTES,
  BUFFER_PRESETS_MIN,
  CUTOFF_PRESETS_HOURS,
  LEAD_PRESETS_MIN,
  MAX_DAYS_PRESETS,
  bufferOptions,
  cutoffLabel,
  cutoffOptions,
  describeBuffer,
  describeLead,
  describeMaxDays,
  formatDaysAhead,
  formatDuration,
  isValidLeadMinutes,
  leadMinutesToLegacyHours,
  leadOptions,
  maxDaysOptions,
} from "./bookingRuleUnits.js";

/**
 * Booking rules in words. A barber typed 15 into "Min notice (hours)" meaning
 * fifteen minutes and turned away a same-day client; every rule now reads in
 * its unit, and the notice can be fifteen minutes.
 */

describe("formatDuration", () => {
  it.each([
    [0, "0 minutes"],
    [1, "1 minute"],
    [15, "15 minutes"],
    [45, "45 minutes"],
    [60, "1 hour"],
    [90, "1 hour 30 minutes"],
    [120, "2 hours"],
    [720, "12 hours"],
    [1_440, "1 day"],
    [2_160, "36 hours"],
    [2_880, "2 days"],
    [10_080, "1 week"],
    [20_160, "2 weeks"],
    [43_200, "30 days"],
  ])("%i minutes reads as %s", (m, words) => {
    expect(formatDuration(m)).toBe(words);
  });

  it("🔴 never a fraction of an hour", () => {
    for (let m = 0; m <= 600; m += 5) expect(formatDuration(m)).not.toMatch(/\d\.\d/);
  });

  it("a bad number reads as 0, never NaN", () => {
    expect(formatDuration(Number.NaN)).toBe("0 minutes");
    expect(formatDuration(-5)).toBe("0 minutes");
  });
});

describe("formatDaysAhead", () => {
  it.each([
    [1, "1 day"],
    [7, "1 week"],
    [14, "2 weeks"],
    [21, "3 weeks"],
    [30, "1 month (30 days)"],
    [45, "45 days"],
    [60, "2 months (60 days)"],
    [90, "3 months (90 days)"],
    [180, "6 months (180 days)"],
    [365, "1 year (365 days)"],
  ])("%i days reads as %s", (d, words) => {
    expect(formatDaysAhead(d)).toBe(words);
  });
});

describe("the minimum notice", () => {
  it("offers 15 minutes, and says so in minutes", () => {
    const fifteen = leadOptions(120).find((o) => o.value === 15);
    expect(fifteen?.label).toBe("15 minutes");
    expect(describeLead(15)).toBe("Clients must book at least 15 minutes ahead.");
  });

  it("0 is No limit", () => {
    expect(leadOptions(0)[0]).toEqual({ value: 0, label: "No limit" });
    expect(describeLead(0)).toMatch(/^No limit/);
  });

  it("🔴 the shop's current value is always a choice, labelled in its unit (nothing silently changes)", () => {
    const opts = leadOptions(900); // 15 hours - what the barber typed
    expect(opts.find((o) => o.value === 900)?.label).toBe("15 hours");
    expect(opts.map((o) => o.value)).toEqual([...opts.map((o) => o.value)].sort((a, b) => a - b));
    // A preset value is not listed twice.
    expect(leadOptions(120).filter((o) => o.value === 120)).toHaveLength(1);
  });

  it("every preset is a value the API accepts", () => {
    for (const m of LEAD_PRESETS_MIN) expect(isValidLeadMinutes(m)).toBe(true);
    expect(isValidLeadMinutes(BOOKING_LEAD_MAX_MINUTES + 1)).toBe(false);
    expect(isValidLeadMinutes(1.5)).toBe(false);
    expect(isValidLeadMinutes(-1)).toBe(false);
  });

  it("🔴 the legacy hours column rounds UP, so old code never reads a shorter notice", () => {
    expect(leadMinutesToLegacyHours(0)).toBe(0);
    expect(leadMinutesToLegacyHours(15)).toBe(1);
    expect(leadMinutesToLegacyHours(60)).toBe(1);
    expect(leadMinutesToLegacyHours(61)).toBe(2);
    expect(leadMinutesToLegacyHours(BOOKING_LEAD_MAX_MINUTES)).toBe(720);
  });
});

describe("how far ahead", () => {
  it("presets run a week to a year, all inside the API's 1..365", () => {
    for (const d of MAX_DAYS_PRESETS) expect(d >= 1 && d <= 365).toBe(true);
    expect(maxDaysOptions(60).find((o) => o.value === 60)?.label).toBe("2 months (60 days)");
  });

  it("keeps an off-preset current value", () => {
    expect(maxDaysOptions(45).find((o) => o.value === 45)?.label).toBe("45 days");
    expect(describeMaxDays(14)).toBe("Clients can book up to 2 weeks ahead.");
  });
});

describe("the buffer", () => {
  it("None, then minutes, all inside 0..240", () => {
    const opts = bufferOptions(0);
    expect(opts[0]).toEqual({ value: 0, label: "None" });
    expect(opts.find((o) => o.value === 15)?.label).toBe("15 minutes");
    for (const m of BUFFER_PRESETS_MIN) expect(m >= 0 && m <= 240).toBe(true);
    expect(bufferOptions(7).find((o) => o.value === 7)?.label).toBe("7 minutes");
  });

  it("says the last slot needs its buffer too", () => {
    expect(describeBuffer(15)).toMatch(/final booking ends 15 minutes before closing/);
    expect(describeBuffer(0)).toMatch(/back to back/);
  });
});

describe("the reschedule / cancel cutoffs", () => {
  it("Anytime, then hours and days before, never past the week", () => {
    expect(cutoffLabel(0)).toBe("Anytime");
    expect(cutoffLabel(1)).toBe("1 hour before");
    expect(cutoffLabel(24)).toBe("1 day before");
    expect(cutoffLabel(168)).toBe("1 week before");
    for (const h of CUTOFF_PRESETS_HOURS) expect(h >= 0 && h <= 168).toBe(true);
    expect(cutoffOptions(24, 168).map((o) => o.value)).toEqual([...CUTOFF_PRESETS_HOURS]);
  });

  it("keeps an off-preset current value", () => {
    expect(cutoffOptions(5, 168).find((o) => o.value === 5)?.label).toBe("5 hours before");
  });
});
