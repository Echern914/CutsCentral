import { describe, expect, it } from "vitest";
import type { RewardProgram } from "./types";
import {
  claimed,
  countdown,
  countdownSpoken,
  dealEnds,
  dealValue,
  shows,
  stamps,
  timerNote,
  timerView,
} from "./rewardsTab";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();

function program(over: Partial<RewardProgram> = {}): RewardProgram {
  return {
    shop: { key: "k", name: "Fade District", logoUrl: null, timezone: "America/New_York" } as RewardProgram["shop"],
    tier: { label: null, visits: 0, perk: null, next: null },
    cards: [],
    activity: [],
    otherProfileHasPunches: false,
    ...over,
  };
}

describe("the rebooking timer", () => {
  it("🔴 counts down to the deadline, to the second", () => {
    const left = countdown(at(2 * DAY + 3 * HOUR + 4 * 60_000 + 5_000), NOW);
    expect(left).toMatchObject({ days: 2, hours: 3, minutes: 4, seconds: 5 });
  });

  it("never runs below zero", () => {
    expect(countdown(at(-DAY), NOW).totalMs).toBe(0);
  });

  it("🔴 counting, urgent under two days - the rewards page's line", () => {
    const calm = timerView({ state: "counting", deadline: at(5 * DAY), windowDays: 14, upcomingAt: null }, NOW);
    expect(calm).toMatchObject({ kind: "counting", urgent: false });
    expect(timerNote(calm)).toBe("Rebook within 14 days to keep your streak.");
    const close = timerView({ state: "counting", deadline: at(DAY + HOUR), windowDays: 14, upcomingAt: null }, NOW);
    expect(close).toMatchObject({ kind: "counting", urgent: true });
    expect(timerNote(close)).toBe("Your window closes soon. Grab a slot.");
  });

  it("overdue once the deadline passes - even if the server last said counting", () => {
    expect(timerView({ state: "overdue", deadline: at(-DAY), windowDays: 14, upcomingAt: null }, NOW).kind).toBe("overdue");
    const ranOut = timerView({ state: "counting", deadline: at(-1000), windowDays: 14, upcomingAt: null }, NOW);
    expect(ranOut.kind).toBe("overdue");
    expect(timerNote(ranOut)).toBe("Book now to stay on track.");
  });

  it("booked: no clock, the next visit", () => {
    expect(timerView({ state: "booked", deadline: null, windowDays: 14, upcomingAt: at(DAY) }, NOW)).toEqual({
      kind: "booked",
      upcomingAt: at(DAY),
    });
  });

  it("nothing to count from - or an older API that sends no timer - shows nothing", () => {
    expect(timerView({ state: "none", deadline: null, windowDays: 14, upcomingAt: null }, NOW).kind).toBe("hidden");
    expect(timerView(undefined, NOW).kind).toBe("hidden");
  });

  it("spoken to the minute, never the second", () => {
    expect(countdownSpoken(countdown(at(2 * DAY + 3 * HOUR + 4 * 60_000 + 59_000), NOW))).toBe(
      "2 days, 3 hours and 4 minutes left to rebook",
    );
    expect(countdownSpoken(countdown(at(60_000 + 30_000), NOW))).toBe("1 minute left to rebook");
  });
});

describe("what the tab shows", () => {
  it("🔴 the shop's own choice of sections - and everything for an older API", () => {
    expect(shows(program({ sections: ["rebook", "punchGrid"] }), "rebook")).toBe(true);
    expect(shows(program({ sections: ["rebook", "punchGrid"] }), "promotions")).toBe(false);
    expect(shows(program(), "promotions")).toBe(true);
  });

  it("stamps fill up to the balance, for a card small enough to read as stamps", () => {
    expect(stamps(3, 5)).toEqual([true, true, true, false, false]);
    expect(stamps(9, 5)).toEqual([true, true, true, true, true]);
    expect(stamps(4, 25)).toBeNull();
    expect(stamps(4, 0)).toBeNull();
  });

  it("claimed rewards come from the activity, newest first", () => {
    const p = program({
      activity: [
        { date: at(-DAY), kind: "earned", punches: 1, label: "Visit" },
        { date: at(-2 * DAY), kind: "redeemed", punches: -5, label: "$10 off" },
      ],
    });
    expect(claimed(p)).toEqual([{ date: at(-2 * DAY), label: "$10 off" }]);
  });

  it("deals read the way the shop's page says them", () => {
    const deal = { id: "d", title: "Weekday", description: null, code: null, percentOff: null, amountOff: null, extraPunches: null, endsAt: null };
    expect(dealValue({ ...deal, kind: "PERCENT_OFF", percentOff: 20 })).toBe("20% off");
    expect(dealValue({ ...deal, kind: "AMOUNT_OFF", amountOff: 5 })).toBe("$5 off");
    expect(dealValue({ ...deal, kind: "EXTRA_PUNCHES", extraPunches: 1 })).toBe("+1 punch per visit");
    expect(dealValue({ ...deal, kind: "EXTRA_PUNCHES", extraPunches: 2 })).toBe("+2 punches per visit");
    expect(dealEnds(at(DAY - HOUR), NOW)).toBe("last day");
    expect(dealEnds(at(3 * DAY), NOW)).toBe("ends in 3 days");
    expect(dealEnds(null, NOW)).toBeNull();
  });
});
