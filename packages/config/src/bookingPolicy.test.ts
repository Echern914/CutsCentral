import { describe, expect, it } from "vitest";
import {
  BOOKING_CHECKLIST_LINE_MAX,
  BOOKING_CHECKLIST_MAX_LINES,
  BOOKING_POLICY_TEXT_MAX,
  bookingPolicyIsBlank,
  normalizeBookingPolicy,
} from "./bookingPolicy.js";

describe("normalizeBookingPolicy", () => {
  it("🔴 blank text and no lines is OFF - the shop that existed before this feature", () => {
    const p = normalizeBookingPolicy({ text: "   ", checklist: ["", "  "] });
    expect(p).toEqual({ text: null, checklist: [] });
    expect(bookingPolicyIsBlank(p)).toBe(true);
    expect(bookingPolicyIsBlank(normalizeBookingPolicy({}))).toBe(true);
    expect(bookingPolicyIsBlank(normalizeBookingPolicy({ text: null, checklist: null }))).toBe(true);
  });

  it("trims, and drops blank lines instead of rendering an empty box to tick", () => {
    const p = normalizeBookingPolicy({
      text: "  Be on time.  ",
      checklist: [" I'll arrive 5 minutes early ", "", "Late counts as a no-show"],
    });
    expect(p).toEqual({
      text: "Be on time.",
      checklist: ["I'll arrive 5 minutes early", "Late counts as a no-show"],
    });
    expect(bookingPolicyIsBlank(p)).toBe(false);
  });

  it("text alone, or a checklist alone, is not blank", () => {
    expect(bookingPolicyIsBlank(normalizeBookingPolicy({ text: "x" }))).toBe(false);
    expect(bookingPolicyIsBlank(normalizeBookingPolicy({ checklist: ["x"] }))).toBe(false);
  });

  it("pins the limits the settings form and both APIs share", () => {
    expect(BOOKING_POLICY_TEXT_MAX).toBe(2000);
    expect(BOOKING_CHECKLIST_MAX_LINES).toBe(8);
    expect(BOOKING_CHECKLIST_LINE_MAX).toBe(160);
  });
});
