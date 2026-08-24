import { describe, expect, it } from "vitest";
import { bucketIndexFor, resolvePeriodWindow } from "./insightsWindow.js";

/**
 * Which bucket a day lands in.
 *
 * 🔴 THE BUG THIS PINS. bucketIndexFor divided the offset from windowStart by
 * the bucket width and ROUNDED. For week buckets the quotient is only a whole
 * number on the anchor day, so days 4, 5 and 6 of every week - Friday,
 * Saturday and Sunday on a Monday-start week - rounded UP into the following
 * bucket. In the newest week that produced index === buckets.length, which
 * reads as outside the window, and the day was dropped from the chart
 * entirely.
 *
 * For a barbershop that is the worst possible three days to lose: the weekly
 * cuts and revenue bars under-reported the weekend and pushed it onto the next
 * week, which makes every week look like it started strong and ended dead.
 *
 * It hid for months because it only shows when data lands in the back half of
 * a bucket. Two Insights suites failed on a Monday and passed on a Friday for
 * exactly this reason.
 *
 * Every case here passes an explicit `now`, so nothing depends on the day the
 * suite runs.
 */

const DAY = 86_400_000;
/** A Wednesday, so "today" is mid-week and the newest bucket is partial. */
const NOW = new Date("2026-06-17T12:00:00.000Z");

/** The UTC-midnight day marker N days before the window's newest day. */
const dayBefore = (period: { today: Date }, n: number) =>
  new Date(period.today.getTime() - n * DAY);

describe("week buckets: every day lands in its own week", () => {
  const period = resolvePeriodWindow(NOW, "UTC", "90d", "week");

  it("🔑 seven consecutive days occupy at most two buckets, in order", () => {
    // Under the rounding bug this sequence jumped a bucket mid-week and then
    // jumped back, which is not something a calendar can do.
    const seen = Array.from({ length: 7 }, (_, n) =>
      bucketIndexFor(period, dayBefore(period, n)),
    );
    for (const i of seen) expect(i).toBeGreaterThanOrEqual(0);
    // Monotonic as we walk backwards in time.
    for (let k = 1; k < seen.length; k++) {
      expect(seen[k]!).toBeLessThanOrEqual(seen[k - 1]!);
    }
    expect(new Set(seen).size).toBeLessThanOrEqual(2);
  });

  it("🔴 no recent day falls outside the window", () => {
    // The actual failure: a day two days ago returning -1 and vanishing.
    for (let n = 0; n < 14; n++) {
      const i = bucketIndexFor(period, dayBefore(period, n));
      expect(i, `${n} days ago must be in a bucket`).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(period.buckets.length);
    }
  });

  it("the index it reports is the bucket that actually contains the day", () => {
    // The strongest form: cross-check the arithmetic against the bucket's own
    // start/end, which is the definition the month path already walks.
    for (let n = 0; n < 60; n++) {
      const day = dayBefore(period, n);
      const i = bucketIndexFor(period, day);
      const b = period.buckets[i];
      expect(b, `no bucket for ${n} days ago`).toBeTruthy();
      expect(day.getTime()).toBeGreaterThanOrEqual(b!.start.getTime());
      expect(day.getTime()).toBeLessThan(b!.end.getTime());
    }
  });

  it("still refuses a day before the window", () => {
    const before = new Date(period.windowStart.getTime() - DAY);
    expect(bucketIndexFor(period, before)).toBe(-1);
  });
});

describe("day buckets", () => {
  const period = resolvePeriodWindow(NOW, "UTC", "30d", "day");

  it("each day is its own bucket, newest last", () => {
    expect(bucketIndexFor(period, period.today)).toBe(period.buckets.length - 1);
    expect(bucketIndexFor(period, dayBefore(period, 1))).toBe(
      period.buckets.length - 2,
    );
    expect(bucketIndexFor(period, period.windowStart)).toBe(0);
  });

  it("every day in the window resolves to the bucket containing it", () => {
    for (let n = 0; n < period.buckets.length; n++) {
      const day = dayBefore(period, n);
      const b = period.buckets[bucketIndexFor(period, day)];
      expect(b).toBeTruthy();
      expect(day.getTime()).toBeGreaterThanOrEqual(b!.start.getTime());
      expect(day.getTime()).toBeLessThan(b!.end.getTime());
    }
  });
});

describe("month buckets were never affected, and stay right", () => {
  // Months walk their bucket list rather than doing width arithmetic, so they
  // never had the bug - pinned so a later "simplification" cannot introduce it.
  const period = resolvePeriodWindow(NOW, "UTC", "365d", "month");

  it("resolves each day to the month containing it", () => {
    for (let n = 0; n < 300; n += 7) {
      const day = dayBefore(period, n);
      const i = bucketIndexFor(period, day);
      if (i < 0) continue; // older than the window
      const b = period.buckets[i]!;
      expect(day.getTime()).toBeGreaterThanOrEqual(b.start.getTime());
      expect(day.getTime()).toBeLessThan(b.end.getTime());
    }
  });
});

describe("🔴 the exact production symptom: the newest weekend", () => {
  // NOW is a SUNDAY, so the current week bucket already contains Fri, Sat and
  // Sun. Those are the three days rounding pushed to index === buckets.length,
  // i.e. straight out of the chart - and for a barbershop they are the busiest
  // days of the week.
  const SUNDAY = new Date("2026-06-21T12:00:00.000Z");
  const period = resolvePeriodWindow(SUNDAY, "UTC", "90d", "week");

  it("today, yesterday and the day before all land in the newest bucket", () => {
    const newest = period.buckets.length - 1;
    for (const n of [0, 1, 2]) {
      const i = bucketIndexFor(period, dayBefore(period, n));
      expect(i, `${n} days ago (Sun/Sat/Fri) must be in the newest week`).toBe(
        newest,
      );
    }
  });

  it("and none of them reports -1", () => {
    for (const n of [0, 1, 2]) {
      expect(bucketIndexFor(period, dayBefore(period, n))).not.toBe(-1);
    }
  });
});
