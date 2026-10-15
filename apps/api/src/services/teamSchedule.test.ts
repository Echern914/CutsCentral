import { describe, expect, it } from "vitest";
import { buildChairDay, dayWindow, scheduleDays, type ChairDayInput } from "./teamSchedule.js";

/**
 * One chair's day, pure: hours, off, booked, free and "where are they now".
 * The day is Thursday 2027-01-14 in UTC unless a test says otherwise.
 */
const at = (hhmm: string, day = "2027-01-14") => new Date(`${day}T${hhmm}:00.000Z`);
const DAY = { from: at("00:00"), to: at("00:00", "2027-01-15") };
const THU = 4;
const span = (a: string, b: string) => ({ startsAt: at(a), endsAt: at(b) });
const iso = (a: string, b: string) => ({ start: at(a).toISOString(), end: at(b).toISOString() });

function input(over: Partial<ChairDayInput> = {}): ChairDayInput {
  return {
    name: "Chris",
    rules: [{ weekday: THU, startMin: 9 * 60, endMin: 17 * 60 }],
    recurringBlocks: [],
    exceptions: [],
    externalBlocks: [],
    occupied: [],
    ...over,
  };
}
// A "now" on another day, so `now` is null unless a test wants it.
const ELSEWHEN = at("12:00", "2027-02-01");

describe("buildChairDay", () => {
  it("hours come from the weekly rules for that weekday, in the MEMBER's zone", () => {
    expect(buildChairDay(input(), DAY, "UTC", ELSEWHEN).hours).toEqual([iso("09:00", "17:00")]);
    // A member in Chicago working 9-5 their time is 15:00-23:00 UTC in January.
    expect(buildChairDay(input(), DAY, "America/Chicago", ELSEWHEN).hours).toEqual([iso("15:00", "23:00")]);
  });

  it("a day with no rule is a day off; a one-off open adds hours", () => {
    const friday = input({ rules: [{ weekday: 5, startMin: 540, endMin: 1020 }] });
    expect(buildChairDay(friday, DAY, "UTC", ELSEWHEN).hours).toEqual([]);
    const opened = input({
      rules: [],
      exceptions: [{ ...span("18:00", "20:00"), isBlock: false, serviceIds: [] }],
    });
    expect(buildChairDay(opened, DAY, "UTC", ELSEWHEN).hours).toEqual([iso("18:00", "20:00")]);
  });

  it("off = breaks, whole-chair blocks and Acuity blocks, inside their hours", () => {
    const day = buildChairDay(
      input({
        recurringBlocks: [{ weekday: THU, startMin: 12 * 60, endMin: 12 * 60 + 30 }],
        exceptions: [
          { ...span("15:00", "16:00"), isBlock: true, serviceIds: [] },
          // A block for SOME services only: the chair still works.
          { ...span("10:00", "11:00"), isBlock: true, serviceIds: ["svc-shape-up"] },
        ],
        // Acuity block reaching past closing: only the part inside hours shows.
        externalBlocks: [span("16:30", "19:00")],
      }),
      DAY,
      "UTC",
      ELSEWHEN,
    );
    expect(day.off).toEqual([iso("12:00", "12:30"), iso("15:00", "16:00"), iso("16:30", "17:00")]);
    expect(day.free).toEqual([iso("09:00", "12:00"), iso("12:30", "15:00"), iso("16:00", "16:30")]);
  });

  it("booked spans are times only, and free is what's left", () => {
    const day = buildChairDay(input({ occupied: [span("13:00", "13:30"), span("13:30", "14:00")] }), DAY, "UTC", ELSEWHEN);
    expect(day.booked).toEqual([iso("13:00", "14:00")]);
    expect(day.free).toEqual([iso("09:00", "13:00"), iso("14:00", "17:00")]);
    expect(Object.keys(day).sort()).toEqual(["booked", "free", "hours", "name", "now", "off"]);
  });

  it("booked wins over off where both claim the same minutes", () => {
    const day = buildChairDay(
      input({
        exceptions: [{ ...span("12:00", "13:00"), isBlock: true, serviceIds: [] }],
        occupied: [span("12:30", "13:30")],
      }),
      DAY,
      "UTC",
      ELSEWHEN,
    );
    expect(day.off).toEqual([iso("12:00", "12:30")]);
    expect(day.booked).toEqual([iso("12:30", "13:30")]);
  });

  it("anything outside the day is cut at its edges", () => {
    const day = buildChairDay(
      input({ rules: [{ weekday: THU, startMin: 0, endMin: 1440 }], occupied: [span("23:30", "23:59")] }),
      DAY,
      "UTC",
      ELSEWHEN,
    );
    expect(day.hours).toEqual([{ start: DAY.from.toISOString(), end: DAY.to.toISOString() }]);
  });
});

describe("where they are now", () => {
  const busyDay = input({
    recurringBlocks: [{ weekday: THU, startMin: 12 * 60, endMin: 12 * 60 + 30 }],
    occupied: [span("10:00", "10:45")],
  });
  const now = (hhmm: string) => buildChairDay(busyDay, DAY, "UTC", at(hhmm)).now;

  it("before, during and after the day", () => {
    expect(now("08:15")).toEqual({ kind: "starts", at: at("09:00").toISOString() });
    expect(now("09:30")).toEqual({ kind: "free", until: at("10:00").toISOString() });
    expect(now("10:10")).toEqual({ kind: "busy", until: at("10:45").toISOString() });
    expect(now("12:05")).toEqual({ kind: "away", until: at("12:30").toISOString() });
    expect(now("12:30")).toEqual({ kind: "free", until: at("17:00").toISOString() });
    expect(now("17:00")).toEqual({ kind: "done" });
  });

  it("a day off says off; a split shift says when they're back", () => {
    expect(buildChairDay(input({ rules: [] }), DAY, "UTC", at("11:00")).now).toEqual({ kind: "off" });
    const split = input({
      rules: [
        { weekday: THU, startMin: 9 * 60, endMin: 12 * 60 },
        { weekday: THU, startMin: 14 * 60, endMin: 18 * 60 },
      ],
    });
    expect(buildChairDay(split, DAY, "UTC", at("13:00")).now).toEqual({ kind: "starts", at: at("14:00").toISOString() });
  });

  it("a cut after hours on a day off still reads as busy while it runs", () => {
    const late = input({ rules: [], occupied: [span("19:00", "19:30")] });
    expect(buildChairDay(late, DAY, "UTC", at("19:10")).now).toEqual({ kind: "busy", until: at("19:30").toISOString() });
  });

  it("only today has a now", () => {
    expect(buildChairDay(busyDay, DAY, "UTC", at("10:00", "2027-01-15")).now).toBeNull();
  });
});

describe("days", () => {
  it("a week from today in the TEAM's calendar, across a month end", () => {
    // 01:00 UTC on Jan 31 is still Jan 30 in New York.
    expect(scheduleDays(new Date("2027-01-31T01:00:00Z"), "America/New_York")).toEqual([
      "2027-01-30",
      "2027-01-31",
      "2027-02-01",
      "2027-02-02",
      "2027-02-03",
      "2027-02-04",
      "2027-02-05",
    ]);
  });

  it("a day is local midnight to local midnight, 23 hours on the spring-forward day", () => {
    const w = dayWindow("2027-03-14", "America/New_York");
    expect(w.from.toISOString()).toBe("2027-03-14T05:00:00.000Z");
    expect(w.to.toISOString()).toBe("2027-03-15T04:00:00.000Z");
  });
});
