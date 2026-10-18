import { describe, expect, it } from "vitest";
import { findHelp } from "./helpMatch.js";
import { openSlotsText, openSlotsWindows, type OpenSlotsBrief, type OpenSlotsDay } from "./openSlots.js";
import { resolveSupport, resolveSupportAnswerById } from "./supportEngine.js";

/**
 * "How many slots do I have open for next week?" - Drick's question
 * (2026-10-18). Answered from the shop's own calendar when the Assistant
 * supplies the count, and with a pointer to the calendar everywhere else.
 */

// Counted on Sunday Oct 18 2026: this week is today alone, next week Oct 19-25.
const day = (date: string, weekday: number, open: number, capacity: number): OpenSlotsDay => ({
  date,
  weekday,
  open,
  capacity,
});

const BRIEF: OpenSlotsBrief = {
  scope: "shop",
  today: "2026-10-18",
  days: [
    day("2026-10-18", 0, 0, 0),
    day("2026-10-19", 1, 4, 16),
    day("2026-10-20", 2, 6, 16),
    day("2026-10-21", 3, 5, 16),
    day("2026-10-22", 4, 8, 16),
    day("2026-10-23", 5, 0, 16),
    day("2026-10-24", 6, 0, 16),
    day("2026-10-25", 0, 0, 0),
  ],
  chairs: 2,
  service: "Cut (30 min)",
  bookingUrl: "https://getchairback.com/book/drick",
};

describe("matching Drick's question", () => {
  it("🔴 every way of asking reaches the open-slots answer", () => {
    for (const q of [
      "How many slots do I have open for next week?",
      "how many slots do i have open next week",
      "how many slots do i have open",
      "how many openings this week",
      "how many openings next week",
      "how many openings do i have next week",
      "when is my next opening",
      "how many open slots tomorrow",
      "how many spots do i have left this week",
      "how many open times do I have",
    ]) {
      expect(findHelp(q).answer?.id, q).toBe("open-slots");
    }
  });

  it("🔴 does not take questions that only share its generic words", () => {
    const cases: [string, string | undefined][] = [
      ["how many texts do I get", "how-many-texts"],
      ["how do I set my hours", "set-hours"],
      ["what happens when I'm fully booked", "waitlist"],
      ["Can I offer an open slot to my best clients first?", "tier-openings"],
      ["a time isn't showing up for clients", "slot-not-showing"],
      ["how does online booking work", "how-booking-works"],
      ["how do I get booked out more", "more-clients"],
    ];
    for (const [q, id] of cases) expect(findHelp(q).answer?.id, q).toBe(id);
    for (const q of ["how many appointments do I have next week", "how many clients do I have", "how many bookings do I have this week"]) {
      expect(findHelp(q).answer?.id, q).not.toBe("open-slots");
    }
  });
});

describe("which days the question is about (shop's week is Monday-Sunday)", () => {
  // Wednesday Oct 14 2026.
  const wed = "2026-10-14";
  it("next week is the coming Monday through Sunday", () => {
    expect(openSlotsWindows("how many slots next week", wed)).toEqual([
      { label: "Next week (Oct 19-25)", from: "2026-10-19", to: "2026-10-25" },
    ]);
  });
  it("this week is what is left of it, today included", () => {
    expect(openSlotsWindows("open slots this week", wed)).toEqual([
      { label: "The rest of this week (Oct 14-18)", from: wed, to: "2026-10-18" },
    ]);
  });
  it("on a Sunday, next week starts tomorrow", () => {
    expect(openSlotsWindows("next week", "2026-10-18")[0]).toMatchObject({ from: "2026-10-19", to: "2026-10-25" });
  });
  it("a week across a month says both months", () => {
    expect(openSlotsWindows("next week", "2026-10-22")[0]!.label).toBe("Next week (Oct 26-Nov 1)");
  });
  it("tomorrow, today and a named weekday", () => {
    expect(openSlotsWindows("open slots tomorrow", wed)[0]).toMatchObject({ from: "2026-10-15", to: "2026-10-15" });
    expect(openSlotsWindows("openings today", wed)[0]).toMatchObject({ from: wed, to: wed });
    expect(openSlotsWindows("any openings friday", wed)[0]).toMatchObject({ label: "Friday (Oct 16)", from: "2026-10-16" });
    // Today's own weekday is today, not a week out.
    expect(openSlotsWindows("openings wednesday", wed)[0]).toMatchObject({ from: wed });
  });
  it("no period named: this week and next", () => {
    expect(openSlotsWindows("how many open slots do i have", wed).map((w) => w.from)).toEqual([wed, "2026-10-19"]);
  });
});

describe("with the shop's own count", () => {
  const ask = (question: string, brief: OpenSlotsBrief = BRIEF) =>
    resolveSupport({
      question,
      actor: "owner",
      channel: "in_app",
      seat: { role: "OWNER" },
      facts: { openSlots: brief },
    });

  it("🔴 Drick's question gets the count, day by day, and says what an open time is", () => {
    const r = ask("How many slots do I have open for next week?");
    expect(r.outcome).toBe("ANSWERED");
    const [first, second, definition, page] = r.answer!.body.split("\n\n");
    expect(first).toBe(
      "Next week (Oct 19-25) you have 23 open times across 2 chairs: Mon 4, Tue 6, Wed 5, Thu 8, Fri 0 (full), Sat 0 (full), Sun closed. That's 23 of the 96 times your hours offer still open. Busiest: Fri and Sat (full).",
    );
    expect(second).toContain("for Cut (30 min), counted once per chair - not once per service");
    expect(definition).toBe("Your booking page: https://getchairback.com/book/drick");
    expect(page).toBeUndefined();
    expect(r.sources[0]).toEqual({ authority: "live_state", id: "openSlots" });
    expect(r.wantedFact).toBeUndefined();
    expect(r.answer!.basis).toMatch(/shop's calendar/);
  });

  it("a provider's own count says so", () => {
    const r = ask("how many open slots tomorrow", { ...BRIEF, scope: "own", chairs: 1, today: "2026-10-21" });
    expect(r.answer!.body.split("\n\n")[0]).toBe("Tomorrow (Thu Oct 22) you have 8 open times on your chair, of 16 your hours offer.");
  });

  it("never a number for a day the count does not reach", () => {
    const r = ask("how many openings next week", { ...BRIEF, days: BRIEF.days.slice(0, 1) });
    expect(r.answer!.body).toContain("I couldn't count that far ahead");
  });

  it("chairs on different services are described, not named", () => {
    expect(openSlotsText({ ...BRIEF, service: null }, "next week")).toContain("for each chair's usual service");
  });

  it("a tapped topic counts this week and next", () => {
    const r = resolveSupportAnswerById("open-slots", {
      actor: "owner",
      channel: "in_app",
      seat: { role: "OWNER" },
      facts: { openSlots: BRIEF },
    });
    const body = r.answer!.body;
    expect(body).toContain("The rest of this week (Oct 18)");
    expect(body).toContain("Next week (Oct 19-25)");
  });
});

describe("without the count", () => {
  it("🔴 the written pointer, never a number, and the engine names the fact it wanted", () => {
    const r = resolveSupport({
      question: "How many slots do I have open for next week?",
      actor: "owner",
      channel: "in_app",
      seat: { role: "OWNER" },
    });
    expect(r.outcome).toBe("ANSWERED");
    expect(r.answer!.id).toBe("open-slots");
    expect(r.answer!.body).not.toMatch(/\d/);
    expect(r.answer!.body).toMatch(/calendar/);
    expect(r.answer!.body).toMatch(/booking page/);
    expect(r.answer!.action?.featureId).toBe("appointments");
    expect(r.wantedFact).toBe("openSlots");
  });

  it("a customer is never handed a shop's count", () => {
    const r = resolveSupport({
      question: "How many slots do I have open for next week?",
      actor: "public_customer",
      channel: "in_app",
      facts: { openSlots: BRIEF },
    });
    expect(r.outcome).not.toBe("ANSWERED");
    expect(r.answer).toBeNull();
    expect(r.escalation).not.toBeNull();
  });
});
