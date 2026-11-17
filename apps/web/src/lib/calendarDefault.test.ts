import { describe, expect, it } from "vitest";
import { defaultCalendarView } from "./calendarDefault";

/**
 * WHICH VIEW THE CALENDAR OPENS ON, from the request's browser. A computer
 * opens on the Week (the desk view the website shows); a phone on the Month,
 * so it never paints a week placeholder it cannot use first.
 */
describe("defaultCalendarView", () => {
  it.each([
    ["Safari on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"],
    ["the ChairBack iOS app", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"],
    ["an iPod", "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"],
    ["Chrome on an Android phone", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"],
  ])("a phone opens on the Month: %s", (_name, ua) => {
    expect(defaultCalendarView(ua)).toBe("month");
  });

  it.each([
    ["Chrome on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],
    ["Safari on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"],
    ["an Android tablet (no 'Mobile')", "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],
  ])("a computer or tablet opens on the Week (where it fits): %s", (_name, ua) => {
    expect(defaultCalendarView(ua)).toBe("week");
  });

  it("no browser named: the Week, which the calendar still drops where it does not fit", () => {
    expect(defaultCalendarView(null)).toBe("week");
    expect(defaultCalendarView(undefined)).toBe("week");
    expect(defaultCalendarView("")).toBe("week");
  });
});
