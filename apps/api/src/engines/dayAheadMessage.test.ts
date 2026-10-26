import { describe, expect, it } from "vitest";
import { dayAheadMessage, type DayAheadRow } from "./barberReminders.js";

/**
 * The barber's evening summary of tomorrow, as a barber asked for it: counts
 * first ("2 confirmed appointments"), one short line, and words that fit every
 * kind of shop - not "2 cuts" on a nail tech's lock screen.
 */
const at = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00Z`);
const row = (hhmm: string, firstName: string, status = "BOOKED", lastName: string | null = null): DayAheadRow => ({
  startsAt: at(hhmm),
  status,
  firstName,
  lastName,
});

describe("dayAheadMessage", () => {
  it("confirmed only: the count, the hours and who is first - no service, no date twice", () => {
    expect(dayAheadMessage([row("08:30", "Jordan", "BOOKED", "R"), row("09:00", "Sam")], "UTC")).toEqual({
      title: "Tomorrow: 2 confirmed appointments",
      body: "8:30 AM to 9:00 AM. First up: Jordan R.",
    });
  });

  it("one appointment: singular, and one time", () => {
    expect(dayAheadMessage([row("10:15", "Sam")], "UTC")).toEqual({
      title: "Tomorrow: 1 confirmed appointment",
      body: "10:15 AM. First up: Sam.",
    });
  });

  it("confirmed and requested: both counted, and the requests called out as needing the barber", () => {
    const m = dayAheadMessage([row("08:00", "Ann", "PENDING"), row("09:00", "Bo"), row("11:00", "Cy", "PENDING")], "UTC");
    expect(m.title).toBe("Tomorrow: 1 confirmed, 2 requested");
    // First up is the first CONFIRMED client - a request may yet be declined.
    expect(m.body).toBe("8:00 AM to 11:00 AM. First up: Bo. 2 requests are waiting for your OK.");
  });

  it("requests only: nothing is confirmed yet, so it asks for a decision", () => {
    expect(dayAheadMessage([row("13:00", "Ann", "PENDING")], "UTC")).toEqual({
      title: "Tomorrow: 1 requested appointment",
      body: "1:00 PM. Tap to accept or decline.",
    });
  });

  it("times are the shop's own clock", () => {
    expect(dayAheadMessage([row("13:30", "Sam")], "America/New_York").body).toBe("9:30 AM. First up: Sam.");
  });

  it("never says 'cut' - every kind of shop gets the same words", () => {
    const m = dayAheadMessage([row("09:00", "Sam"), row("10:00", "Lee", "PENDING")], "UTC");
    expect(`${m.title} ${m.body}`).not.toMatch(/\bcuts?\b/i);
  });
});
