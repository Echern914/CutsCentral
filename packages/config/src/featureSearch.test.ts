import { describe, expect, it } from "vitest";
import { FEATURE_INDEX, searchableFeatures } from "./features.js";
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
/**
 * The index the palette actually types against for an owner: every listed
 * entry plus the searchable public page (Contact support). Not the raw
 * FEATURE_INDEX - the unlisted signup page also knows "get started", and it
 * is never offered to someone who already has a shop.
 */
const INDEX = searchableFeatures({ role: "OWNER", flagsOff: [] });
const top = (q: string) => searchFeatures(q, INDEX)[0]?.entry.name ?? null;

/** query -> the entry that should rank FIRST. Verified against the live index. */
const EXPECTED: [string, string][] = [
  // Booking rules that live behind the Settings tab. These used to answer
  // "Online booking", whose href is the BARE route - i.e. the appointment book,
  // three taps from the setting the barber typed the name of. The rules now
  // have their own entry pointing at ?tab=Settings, which is what this block's
  // heading always claimed.
  ["buffer", "Booking rules"],
  ["minimum notice", "Booking rules"],
  ["days ahead", "Booking rules"],
  ["lead time", "Booking rules"],
  ["pause bookings", "Booking rules"],
  // Adding a walk-in is something you do IN the book, not in booking settings.
  ["walk in", "Appointments"],
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
  // The gallery is literally CALLED photo; a name hit outranks the service
  // editor's "service photo" synonym, per the field weights.
  ["photo", "Photo gallery"],
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
  ["qr code", "Scan-to-book QR code"],
  // Marking a no-show is an action in the book. Reminders REDUCE no-shows,
  // which is a claim for their description to make, not a word to win on.
  ["no show", "Appointments"],
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

/**
 * Round two, measured 2026-09-02 against the live registry with a battery of
 * 130 things an OWNER types. Before: 18 dead ends (tip, hours, add barber,
 * phone number, qr code, sign out, google calendar...) and a run of confidently
 * wrong firsts ("affiliate" -> Refer a barber, "busiest" -> Affiliates, "qr" ->
 * Themes, "dark mode" -> Appointments). Two matcher rules and a vocabulary
 * pass fixed them; this table keeps them fixed.
 */
const EXPECTED_2: [string, string][] = [
  // 🔴 "affiliate" ranked Refer a barber first: Refer listed the word as a
  // synonym, and the exact-name bonus compared RAW strings, so "affiliate"
  // was one letter short of "Affiliates". Equality is on tokens now.
  ["affiliate", "Affiliates"],
  ["afiliate", "Affiliates"], // typo, on purpose
  ["months off", "Affiliates"],
  ["refer", "Refer a barber"],
  ["referral link", "Refer a barber"],
  // The verb wrapper is dropped when a noun remains: "change tier" used to
  // find NOTHING because the AND rule demanded "change" land somewhere too.
  ["tier", "Loyalty status tiers"],
  ["change tier", "Loyalty status tiers"],
  ["tier visits", "Loyalty status tiers"],
  ["gold", "Loyalty status tiers"],
  ["vip", "VIP & custom cards"],
  // The tip-policy toggle lives on the payments page and had no entry: "tip"
  // matched "mul-TIP-le" and nothing else.
  ["tip", "Tips"],
  ["tips", "Tips"],
  ["tipping", "Tips"],
  ["gratuity", "Tips"],
  ["cancellation fee", "Card & Apple Pay at booking"],
  ["card on file", "Card & Apple Pay at booking"],
  // Hours. "hours" alone ranked Automatic reminders (24 HOUR reminder).
  ["hours", "Staff & providers"],
  ["open hours", "Staff & providers"],
  ["lunch", "Staff & providers"],
  ["block time", "Staff & providers"],
  ["add barber", "Staff & providers"],
  ["add a barber", "Staff & providers"],
  // "services" tied Services with Service add-ons and lost on the alphabet;
  // "price" went to Plan & billing - ChairBack's price, not the barber's.
  ["services", "Services & pricing"],
  ["add a service", "Services & pricing"],
  ["price", "Services & pricing"],
  ["prices", "Services & pricing"],
  ["kiosk", "Walk-in queue"],
  ["walk-ins", "Walk-in queue"],
  // The public page carries the booking link and the social/review links.
  ["booking link", "Public shop page"],
  ["instagram", "Public shop page"],
  ["google reviews", "Public shop page"],
  ["booksy", "Acuity & Square sync"],
  ["google calendar", "Acuity & Square sync"],
  ["winback", "Rebooking nudges"],
  ["lapsed", "Rebooking nudges"],
  ["blast", "Promotions"],
  ["promo code", "Promotions"],
  ["notes", "Client book"],
  ["import clients", "Client book"],
  ["phone number", "AI receptionist"],
  ["twilio", "AI receptionist"],
  // Themes claimed "qr code" and has no QR code; the card is on Home.
  ["qr", "Scan-to-book QR code"],
  ["qr code", "Scan-to-book QR code"],
  ["dark mode", "Account & security"],
  ["sign out", "Account & security"],
  ["log out", "Account & security"],
  ["download the app", "Account & security"],
  ["push notifications", "Account & security"],
  ["busiest", "Insights & trends"],
  ["top services", "Insights & trends"],
  ["money", "Insights & trends"],
  ["upgrade", "Plan & billing"],
  ["setup", "Home"],
  ["get started", "Home"],
  ["help", "Assistant"],
  ["support", "Contact support"],
];

describe("feature search: round two (owner vocabulary)", () => {
  it.each(EXPECTED_2)("%j finds %j", (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it("a bare verb still searches - only the WRAPPER is dropped", () => {
    expect(searchFeatures("add", FEATURE_INDEX).length).toBeGreaterThan(0);
    expect(searchFeatures("change", FEATURE_INDEX).length).toBeGreaterThan(0);
    // With a noun present the verb no longer vetoes the entry.
    expect(searchFeatures("turn on reminders", FEATURE_INDEX)[0]?.entry.name).toBe(
      "Automatic reminders",
    );
    expect(searchFeatures("set up my hours", FEATURE_INDEX)[0]?.entry.name).toBe(
      "Staff & providers",
    );
  });

  it("a dead end is honest: nothing in the product answers these", () => {
    // Not features. The palette's empty state hands these to the assistant
    // instead of pretending; if one of them starts matching, something
    // acquired a synonym it should not have.
    for (const q of ["commission", "birthday", "zzzzqqq"]) {
      expect(searchFeatures(q, FEATURE_INDEX), q).toEqual([]);
    }
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
