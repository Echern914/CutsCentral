import { describe, expect, it } from "vitest";
import {
  clockLabel,
  compareSpans,
  dateHoursProblem,
  dateHoursSentence,
  dateLabel,
  datesLabel,
  deltaLabel,
  hhmmToMinute,
  hoursDelta,
  mergeSpans,
  minuteToHhmm,
  spansLabel,
  usualSpans,
  weekdayOfDateKey,
} from "./dateHoursPlan.js";

const span = (from: string, to: string) => ({ startMin: hhmmToMinute(from)!, endMin: hhmmToMinute(to)! });

describe("times", () => {
  it("HH:MM to a minute and back, the end of the day included", () => {
    expect(hhmmToMinute("08:00")).toBe(480);
    expect(hhmmToMinute("24:00")).toBe(1440);
    expect(minuteToHhmm(930)).toBe("15:30");
    expect(minuteToHhmm(1440)).toBe("24:00");
    for (const junk of ["", "8", "24:15", "12:60", "ab:cd"]) expect(hhmmToMinute(junk)).toBeNull();
  });

  it("reads like a clock; the end of the day is midnight, never 12:00 AM", () => {
    expect(clockLabel(0)).toBe("12:00 AM");
    expect(clockLabel(480)).toBe("8:00 AM");
    expect(clockLabel(720)).toBe("12:00 PM");
    expect(clockLabel(930)).toBe("3:30 PM");
    expect(clockLabel(1440)).toBe("midnight");
  });

  it("joins hours with 'and'", () => {
    expect(spansLabel([])).toBe("");
    expect(spansLabel([span("08:00", "15:30")])).toBe("8:00 AM – 3:30 PM");
    expect(spansLabel([span("08:00", "15:30"), span("16:30", "20:00")])).toBe(
      "8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM",
    );
  });
});

describe("dateHoursProblem", () => {
  it("nothing wrong with split hours, or with hours that touch", () => {
    expect(dateHoursProblem([span("08:00", "15:30"), span("16:30", "20:00")])).toBeNull();
    expect(dateHoursProblem([span("08:00", "12:00"), span("12:00", "16:00")])).toBeNull();
    expect(dateHoursProblem([])).toBeNull();
  });

  it("a row that ends at or before its start", () => {
    expect(dateHoursProblem([span("10:00", "10:00")])).toBe("ends_before_start");
    expect(dateHoursProblem([span("10:00", "09:00")])).toBe("ends_before_start");
  });

  it("two rows that share time, in whatever order they were typed", () => {
    expect(dateHoursProblem([span("12:00", "16:00"), span("08:00", "13:00")])).toBe("overlap");
  });
});

describe("usualSpans - the weekly rule, restated to draw the comparison", () => {
  const rules = [
    { weekday: 2, startMin: 750, endMin: 930 },
    { weekday: 2, startMin: 990, endMin: 1200 },
    { weekday: 3, startMin: 600, endMin: 900 },
  ];

  it("the staff hours, when the service has none of its own that weekday", () => {
    expect(usualSpans({ weekday: 2, staffRules: rules, hoursWindows: {}, timeOverrides: [] })).toEqual([
      { startMin: 750, endMin: 930 },
      { startMin: 990, endMin: 1200 },
    ]);
  });

  it("narrowed to the service's weekly hours; present-and-empty is not offered", () => {
    expect(
      usualSpans({ weekday: 2, staffRules: rules, hoursWindows: { "2": [{ s: 800, e: 1000 }] }, timeOverrides: [] }),
    ).toEqual([{ startMin: 800, endMin: 930 }, { startMin: 990, endMin: 1000 }]);
    expect(usualSpans({ weekday: 2, staffRules: rules, hoursWindows: { "2": [] }, timeOverrides: [] })).toEqual([]);
  });

  it("an explicitly opened window joins the day even on a weekday with no hours", () => {
    const opened = [{ s: 1260, e: 1380, days: [5], opensHours: true }];
    expect(usualSpans({ weekday: 5, staffRules: rules, hoursWindows: {}, timeOverrides: opened })).toEqual([
      { startMin: 1260, endMin: 1380 },
    ]);
  });

  it("a weekday nobody works is empty", () => {
    expect(usualSpans({ weekday: 6, staffRules: rules, hoursWindows: {}, timeOverrides: [] })).toEqual([]);
  });
});

describe("hoursDelta", () => {
  const usual = [span("12:30", "15:30"), span("16:30", "20:00")];

  it("longer hours that keep the break closed only add", () => {
    const delta = hoursDelta(usual, [span("08:00", "15:30"), span("16:30", "20:00")]);
    expect(delta).toEqual({ addedMin: 270, removedMin: 0 });
    expect(deltaLabel(delta)).toBe("+4.5 h");
  });

  it("opening straight through the break adds the break too", () => {
    expect(hoursDelta(usual, [span("08:00", "20:00")])).toEqual({ addedMin: 330, removedMin: 0 });
  });

  it("shorter hours take time away, and a shifted day does both", () => {
    expect(deltaLabel(hoursDelta(usual, [span("12:30", "15:30")]))).toBe("−3.5 h");
    expect(deltaLabel(hoursDelta(usual, [span("10:30", "15:30")]))).toBe("+2 h −3.5 h");
  });

  it("closed takes the whole day; the same hours change nothing", () => {
    expect(hoursDelta(usual, [])).toEqual({ addedMin: 0, removedMin: 390 });
    expect(deltaLabel(hoursDelta(usual, usual))).toBe("same");
  });

  it("merges before counting, so overlapping input is not counted twice", () => {
    expect(mergeSpans([span("08:00", "10:00"), span("09:00", "11:00")])).toEqual([span("08:00", "11:00")]);
    expect(hoursDelta([], [span("08:00", "10:00"), span("09:00", "11:00")])).toEqual({ addedMin: 180, removedMin: 0 });
  });
});

describe("compareSpans - what the bar draws", () => {
  const usual = [span("12:30", "15:30"), span("16:30", "20:00")];

  it("longer hours: the usual time is kept, the morning is added, the break stays out", () => {
    expect(compareSpans(usual, [span("08:00", "15:30"), span("16:30", "20:00")])).toEqual({
      kept: usual,
      added: [span("08:00", "12:30")],
      removed: [],
    });
  });

  it("straight through the break: the break is added too", () => {
    expect(compareSpans(usual, [span("08:00", "20:00")]).added).toEqual([span("08:00", "12:30"), span("15:30", "16:30")]);
  });

  it("a shifted day adds at one end and removes at the other", () => {
    expect(compareSpans(usual, [span("10:30", "15:30")])).toEqual({
      kept: [span("12:30", "15:30")],
      added: [span("10:30", "12:30")],
      removed: [span("16:30", "20:00")],
    });
  });

  it("closed removes everything; a day with no usual hours is all added", () => {
    expect(compareSpans(usual, [])).toEqual({ kept: [], added: [], removed: usual });
    expect(compareSpans([], [span("10:00", "12:00")])).toEqual({ kept: [], added: [span("10:00", "12:00")], removed: [] });
  });

  it("agrees with hoursDelta to the minute", () => {
    const next = [span("09:00", "13:00"), span("14:00", "21:00")];
    const cut = compareSpans(usual, next);
    const total = (xs: { startMin: number; endMin: number }[]) => xs.reduce((n, s) => n + s.endMin - s.startMin, 0);
    expect({ addedMin: total(cut.added), removedMin: total(cut.removed) }).toEqual(hoursDelta(usual, next));
  });
});

describe("dates", () => {
  it("knows the weekday of a calendar date without a timezone", () => {
    expect(weekdayOfDateKey("2026-11-26")).toBe(4); // Thanksgiving 2026 is a Thursday
    expect(dateLabel("2026-11-26")).toBe("Thu Nov 26");
  });

  it("names the month once, and again when it changes", () => {
    expect(datesLabel(["2026-11-23"])).toBe("Mon Nov 23");
    expect(datesLabel(["2026-11-25", "2026-11-23", "2026-11-24", "2026-11-27"])).toBe(
      "Mon Nov 23, Tue 24, Wed 25 and Fri 27",
    );
    expect(datesLabel(["2026-11-30", "2026-12-01"])).toBe("Mon Nov 30 and Tue Dec 1");
    expect(datesLabel(["2026-11-23", "2026-11-23"])).toBe("Mon Nov 23");
  });
});

describe("dateHoursSentence - the change read back before saving", () => {
  const dates = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"];

  it("split hours at the usual price", () => {
    expect(
      dateHoursSentence({ serviceName: "Haircut", dates, hours: [span("08:00", "15:30"), span("16:30", "20:00")] }),
    ).toBe(
      "Mon Nov 23, Tue 24, Wed 25 and Fri 27: Haircut is open 8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM, at the usual price.",
    );
  });

  it("a price for those dates, whole dollars or cents", () => {
    const base = { serviceName: "Haircut", dates: ["2026-12-24"], hours: [span("09:00", "17:00")] };
    expect(dateHoursSentence({ ...base, price: 65 })).toBe(
      "Thu Dec 24: Haircut is open 9:00 AM – 5:00 PM, at $65.",
    );
    expect(dateHoursSentence({ ...base, price: 62.5 })).toContain("at $62.50.");
    expect(dateHoursSentence({ ...base, price: null })).toContain("at the usual price.");
  });

  it("not offered", () => {
    expect(dateHoursSentence({ serviceName: "Retwist", dates: ["2026-11-26"], hours: [] })).toBe(
      "Thu Nov 26: Retwist is not offered.",
    );
  });

  it("names the staff when the change is for some of them", () => {
    expect(
      dateHoursSentence({ serviceName: "Haircut", dates: ["2026-11-23"], hours: [span("08:00", "12:00")], staffNames: ["Avery"] }),
    ).toBe("Mon Nov 23: Haircut with Avery is open 8:00 AM – 12:00 PM, at the usual price.");
  });

  it("touching rows read as one stretch; nothing to say until a day is picked", () => {
    expect(
      dateHoursSentence({ serviceName: "Haircut", dates: ["2026-11-23"], hours: [span("08:00", "12:00"), span("12:00", "16:00")] }),
    ).toContain("is open 8:00 AM – 4:00 PM,");
    expect(dateHoursSentence({ serviceName: "Haircut", dates: [], hours: [] })).toBe("");
  });
});
