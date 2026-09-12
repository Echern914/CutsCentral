import { describe, expect, it } from "vitest";
import {
  calendarBlock,
  dayLabel,
  displayPhone,
  initials,
  money,
  progressLine,
  remainingLine,
  shortDate,
  timeRange,
  untilLabel,
} from "./format";

/**
 * The app's words for time and progress. untilLabel's cases are the SAME ones
 * packages/config/src/relativeTime.test.ts pins for the manage page, so the two
 * cannot drift into saying different things about one appointment.
 */

const TZ = "America/New_York";
// Monday 23:00 in New York (03:00Z Tuesday).
const NOW = new Date("2026-09-08T03:00:00Z");
const at = (iso: string) => new Date(iso);

describe("untilLabel - identical to the manage page's", () => {
  it("counts real time under a day", () => {
    expect(untilLabel(at("2026-09-08T03:00:20Z"), NOW, TZ)).toBe("right now");
    expect(untilLabel(at("2026-09-08T03:01:00Z"), NOW, TZ)).toBe("in 1 minute");
    expect(untilLabel(at("2026-09-08T03:45:00Z"), NOW, TZ)).toBe("in 45 minutes");
    expect(untilLabel(at("2026-09-08T04:20:00Z"), NOW, TZ)).toBe("in 1 hour 20 minutes");
    expect(untilLabel(at("2026-09-08T12:10:00Z"), NOW, TZ)).toBe("in 9 hours");
  });

  it("tomorrow is a CALENDAR day in the shop's zone", () => {
    expect(untilLabel(at("2026-09-09T03:00:00Z"), NOW, TZ)).toBe("tomorrow");
    expect(untilLabel(at("2026-09-09T09:00:00Z"), NOW, TZ)).toBe("in 2 days");
  });

  it("weeks past a fortnight, nothing once started", () => {
    expect(untilLabel(at("2026-09-30T15:00:00Z"), NOW, TZ)).toBe("in 3 weeks");
    expect(untilLabel(at("2026-09-08T02:00:00Z"), NOW, TZ)).toBeNull();
  });
});

describe("dates on the shop's clock", () => {
  it("names today and tomorrow, then the weekday", () => {
    const now = new Date("2026-09-15T14:00:00Z"); // Tue 10am NY
    expect(dayLabel("2026-09-15T20:00:00Z", TZ, now)).toBe("Today");
    expect(dayLabel("2026-09-16T14:00:00Z", TZ, now)).toBe("Tomorrow");
    expect(dayLabel("2026-09-18T18:30:00Z", TZ, now)).toBe("Friday, Sep 18");
    expect(dayLabel("2027-01-08T18:30:00Z", TZ, now)).toBe("Friday, Jan 8, 2027");
  });

  it("🔴 a 2:30 appointment reads 2:30 wherever the phone is", () => {
    // 18:30Z is 2:30 PM in New York and 11:30 AM in Los Angeles; the shop is in NY.
    expect(timeRange("2026-09-18T18:30:00Z", "2026-09-18T19:00:00Z", TZ)).toBe("2:30 – 3:00 PM");
    expect(timeRange("2026-09-18T15:30:00Z", "2026-09-18T16:30:00Z", TZ)).toBe("11:30 AM – 12:30 PM");
    expect(timeRange("2026-09-18T18:30:00Z", null, TZ)).toBe("2:30 PM");
  });

  it("short dates and calendar blocks", () => {
    const now = new Date("2026-09-15T14:00:00Z");
    expect(shortDate("2026-08-28T18:00:00Z", TZ, now)).toBe("Aug 28");
    expect(shortDate("2025-08-28T18:00:00Z", TZ, now)).toBe("Aug 28, 2025");
    // 02:00Z on the 19th is still the 18th in New York.
    expect(calendarBlock("2026-09-19T02:00:00Z", TZ)).toEqual({ month: "Sep", day: "18" });
  });
});

describe("the small words", () => {
  it("money, phones and monograms", () => {
    expect(money(4500)).toBe("$45");
    expect(money(4550)).toBe("$45.50");
    expect(displayPhone("+16465550123")).toBe("(646) 555-0123");
    expect(displayPhone(null)).toBeNull();
    expect(initials("Alpha Cuts")).toBe("AC");
    expect(initials("drickcuttinup")).toBe("D");
    expect(initials("  J & K  Studio ")).toBe("JK");
  });

  it("progress reads the way the brief asks: '2 of 5 visits', '3 more visits until $10 off'", () => {
    expect(progressLine(2, 5, "visits")).toBe("2 of 5 visits");
    expect(progressLine(7, 5, "visits")).toBe("5 of 5 visits");
    expect(progressLine(1, 1, "punches")).toBe("1 of 1 punch");
    expect(remainingLine(3, "$10 off", "visits")).toBe("3 more visits until $10 off");
    expect(remainingLine(1, "a free treatment", "punches")).toBe("1 more punch until a free treatment");
  });
});
