import { describe, expect, it } from "vitest";
import { FEATURE_INDEX } from "./features.js";
import { searchFeatures } from "./helpMatch.js";

/**
 * BEHAVIOURAL coverage for the Cmd-K palette.
 *
 * features.test.ts already checks the index's SHAPE (unique ids, non-empty
 * copy, every non-tab page reachable). Nothing checked that typing a word
 * actually found anything - and it didn't: measured against the real index, 37
 * of 46 things a barber would plausibly type returned ZERO, while "age"
 * returned ten results led by "Public shop p-AGE".
 *
 * This table is the regression net for that. Every row is a word somebody
 * would really type. A row going red means either the matcher regressed or a
 * feature's vocabulary was dropped - both worth failing over, because the
 * failure mode is silent: the palette just says "Nothing matches" and the
 * barber concludes the feature doesn't exist.
 */
const top = (q: string) => searchFeatures(q, FEATURE_INDEX)[0]?.entry.name ?? null;

/** query -> the entry that should rank FIRST. Verified against the live index. */
const EXPECTED: [string, string][] = [
  // Booking rules that live behind the Settings tab.
  ["buffer", "Online booking"],
  ["minimum notice", "Online booking"],
  ["days ahead", "Online booking"],
  ["walk in", "Online booking"],
  // Hours, breaks and time away - all on the Staff tab.
  ["staff hours", "Staff & providers"],
  ["lunch break", "Staff & providers"],
  ["break", "Staff & providers"],
  ["block off", "Staff & providers"],
  ["time off", "Staff & providers"],
  ["vacation", "Staff & providers"],
  ["closed", "Staff & providers"],
  // Services.
  ["service group", "Services & pricing"],
  ["max per day", "Services & pricing"],
  ["holiday", "Services & pricing"],
  ["photo", "Services & pricing"],
  ["saterday", "Day-specific pricing & durations"], // typo, on purpose
  // Money.
  ["deposit", "Card & Apple Pay at booking"],
  ["refund", "Card & Apple Pay at booking"],
  ["tax", "Card & Apple Pay at booking"],
  ["receipt", "Card & Apple Pay at booking"],
  ["cancellation policy", "Card & Apple Pay at booking"],
  // Clients.
  ["csv", "Client book"],
  ["merge", "Client book"],
  ["opt out", "Client book"],
  ["consent", "Client book"],
  // Insights.
  ["goal", "Insights & trends"],
  ["chair time", "Insights & trends"],
  ["utilization", "Insights & trends"],
  ["daily target", "Insights & trends"],
  // Everything else that had no vocabulary at all.
  ["acuity", "Acuity & Square sync"],
  ["square", "Acuity & Square sync"],
  ["sync", "Acuity & Square sync"],
  ["domain", "Your own domain"],
  ["timezone", "Time zone"],
  ["qr code", "Themes, fonts & branding"],
  ["no show", "Automatic reminders"],
  ["reminder", "Automatic reminders"],
  ["card punch", "Punch cards & rewards"],
  ["waitlst", "Waitlist"], // typo, on purpose
  ["receptionist", "AI receptionist"],
];

describe("feature search: the words barbers actually type", () => {
  it.each(EXPECTED)("%j finds %j", (query, expected) => {
    expect(top(query)).toBe(expected);
  });
});

describe("feature search: what it must NOT match", () => {
  /**
   * Every one of these was a real, confidently-wrong result under the old
   * substring ladder. A bare `includes()` matches INSIDE words, and a wrong
   * answer delivered with confidence is worse than an empty state - the barber
   * navigates somewhere useless and stops trusting the box.
   */
  it("does not match inside a word", () => {
    expect(top("age")).not.toBe("Public shop page"); // p-AGE
    expect(top("tip")).not.toBe("Staff & providers"); // mul-TIP-le
    expect(top("ical")).not.toBe("Waitlist"); // automat-ICAL-ly
  });

  it("requires EVERY typed word to land (AND, not OR)", () => {
    // "punch" alone is a real hit; the nonsense word must veto the whole entry
    // rather than being quietly ignored.
    expect(searchFeatures("punch", FEATURE_INDEX).length).toBeGreaterThan(0);
    expect(searchFeatures("punch zzzzqqq", FEATURE_INDEX)).toEqual([]);
  });

  it("is word-order independent", () => {
    // The old ladder matched the query as one contiguous substring, so
    // "punch card" worked and "card punch" returned nothing.
    expect(top("punch card")).toBe(top("card punch"));
  });

  it("returns nothing for an empty or junk query", () => {
    expect(searchFeatures("   ", FEATURE_INDEX)).toEqual([]);
    expect(searchFeatures("zzzzqqq", FEATURE_INDEX)).toEqual([]);
  });

  it("never lets a typo outrank an exact match", () => {
    // "waitlist" is an exact name; nothing fuzzy may displace it.
    expect(top("waitlist")).toBe("Waitlist");
  });
});
