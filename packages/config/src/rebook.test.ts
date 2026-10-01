import { describe, expect, it } from "vitest";
import { rebookCountdown } from "./rebook.js";
import { REWARDS_SECTION_DEFAULT, visibleRewardsSections } from "./constants.js";

/**
 * The rebooking countdown is one rule for the web rewards page and the app's
 * Rewards tab (routes/rewards.ts, services/customerPortal.ts).
 */
const now = new Date("2026-09-30T12:00:00.000Z");
const DAY = 86_400_000;

describe("the rebooking countdown", () => {
  it("🔴 counts down from the last visit over the shop's window", () => {
    const r = rebookCountdown({
      lastVisitAt: new Date(now.getTime() - 3 * DAY),
      preferredCadence: null,
      shopWindowDays: 14,
      upcomingAt: null,
      now,
    });
    expect(r).toEqual({
      state: "counting",
      deadline: new Date(now.getTime() + 11 * DAY).toISOString(),
      windowDays: 14,
      upcomingAt: null,
    });
  });

  it("is overdue once the window has passed", () => {
    const r = rebookCountdown({
      lastVisitAt: new Date(now.getTime() - 20 * DAY),
      preferredCadence: null,
      shopWindowDays: 14,
      upcomingAt: null,
      now,
    });
    expect(r.state).toBe("overdue");
  });

  it("a client's own cadence sets the window", () => {
    const r = rebookCountdown({
      lastVisitAt: new Date(now.getTime() - 20 * DAY),
      preferredCadence: "MONTHLY",
      shopWindowDays: 14,
      upcomingAt: null,
      now,
    });
    expect(r).toMatchObject({ state: "counting", windowDays: 30 });
  });

  it("an unknown cadence falls back to the shop's window", () => {
    const r = rebookCountdown({
      lastVisitAt: now,
      preferredCadence: "FORTNIGHTLY-ish",
      shopWindowDays: 21,
      upcomingAt: null,
      now,
    });
    expect(r.windowDays).toBe(21);
  });

  it("🔴 booked beats any countdown - no timer, the next visit instead", () => {
    const at = new Date(now.getTime() + 2 * DAY);
    const r = rebookCountdown({
      lastVisitAt: new Date(now.getTime() - 40 * DAY),
      preferredCadence: null,
      shopWindowDays: 14,
      upcomingAt: at,
      now,
    });
    expect(r).toEqual({ state: "booked", deadline: null, windowDays: 14, upcomingAt: at.toISOString() });
    expect(rebookCountdown({ lastVisitAt: null, preferredCadence: null, shopWindowDays: 14, upcomingAt: at.toISOString(), now }).upcomingAt).toBe(
      at.toISOString(),
    );
  });

  it("no visit yet, nothing to count from", () => {
    const r = rebookCountdown({ lastVisitAt: null, preferredCadence: null, shopWindowDays: 14, upcomingAt: null, now });
    expect(r).toEqual({ state: "none", deadline: null, windowDays: 14, upcomingAt: null });
  });
});

describe("the rewards sections a shop shows", () => {
  it("all of them until the shop chooses", () => {
    expect(visibleRewardsSections([])).toEqual(REWARDS_SECTION_DEFAULT);
    expect(visibleRewardsSections(null)).toEqual(REWARDS_SECTION_DEFAULT);
  });

  it("its own choice, unknown keys dropped", () => {
    expect(visibleRewardsSections(["rebook", "punchGrid", "nope"])).toEqual(["rebook", "punchGrid"]);
    expect(visibleRewardsSections(["nope"])).toEqual(REWARDS_SECTION_DEFAULT);
  });
});
