import { describe, expect, it } from "vitest";
import {
  changeHours,
  changeSignature,
  changeSub,
  changeTitle,
  changedDays,
  changesOn,
  type ChangeService,
  type DayChange,
} from "./dayChanges";

/**
 * A service's own hours on a date, as the calendar speaks about it.
 *
 * "Today" is passed in everywhere, so nothing here can go red on a calendar
 * date. The week used is Mon 23 - Fri 27 Nov 2026 with "today" a week before.
 */
const TODAY = "2026-11-16";
const early = { w: [{ s: 480, e: 930 }, { s: 990, e: 1200 }], staff: [] as string[] };

const haircut: ChangeService = {
  id: "svc1",
  name: "Haircut",
  dateHours: {
    "2026-11-23": { ...early, n: "Holiday week" },
    "2026-11-24": { ...early, n: "Holiday week" },
    "2026-11-25": { ...early, n: "Holiday week" },
    "2026-11-27": { ...early, n: "Holiday week" },
    // The day itself: not offered, and not part of the named week.
    "2026-11-26": { w: [], staff: [] },
  },
  dateOverrides: { "2026-11-23": 60, "2026-11-24": 60, "2026-11-25": 60, "2026-11-27": 60 },
};
const beard: ChangeService = {
  id: "svc2",
  name: "Beard trim",
  dateHours: { "2026-11-23": { w: [{ s: 360, e: 600 }], staff: ["st2"] } },
};
const plain: ChangeService = { id: "svc3", name: "Line up" };

describe("changesOn - what is different about one day", () => {
  it("a day nobody changed has nothing to show", () => {
    expect(changesOn([haircut, beard, plain], "2026-11-30", TODAY)).toEqual([]);
    expect(changesOn([plain], "2026-11-23", TODAY)).toEqual([]);
  });

  it("days set the same way are ONE change, with every one of its days", () => {
    const [change] = changesOn([haircut], "2026-11-24", TODAY);
    expect(change).toEqual({
      serviceId: "svc1",
      serviceName: "Haircut",
      dates: ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"],
      hours: early.w,
      staffIds: [],
      name: "Holiday week",
      price: 60,
    });
  });

  it("a day set differently in the same week is its own change", () => {
    const [change] = changesOn([haircut], "2026-11-26", TODAY);
    expect(change!.dates).toEqual(["2026-11-26"]);
    expect(change!.hours).toEqual([]);
    expect(change!.name).toBeNull();
    expect(change!.price).toBeNull();
  });

  it("the same hours under a different name are two changes", () => {
    const service: ChangeService = {
      id: "svc1",
      name: "Haircut",
      dateHours: {
        "2026-11-23": { ...early, n: "Holiday week" },
        "2026-11-24": { ...early },
      },
    };
    expect(changesOn([service], "2026-11-23", TODAY)[0]!.dates).toEqual(["2026-11-23"]);
    expect(changesOn([service], "2026-11-24", TODAY)[0]!.dates).toEqual(["2026-11-24"]);
  });

  it("each service on the day is its own change, in the order given", () => {
    const got = changesOn([haircut, beard, plain], "2026-11-23", TODAY);
    expect(got.map((c) => c.serviceName)).toEqual(["Haircut", "Beard trim"]);
    expect(got[1]!.staffIds).toEqual(["st2"]);
  });

  it("a day that has passed is not a change any more, and passed days leave the group", () => {
    expect(changesOn([haircut], "2026-11-23", "2026-11-24")).toEqual([]);
    expect(changesOn([haircut], "2026-11-25", "2026-11-25")[0]!.dates).toEqual(["2026-11-25", "2026-11-27"]);
  });

  it("days that do not share one price read back no price", () => {
    const mixed = { ...haircut, dateOverrides: { "2026-11-23": 60, "2026-11-24": 65 } };
    expect(changesOn([mixed], "2026-11-23", TODAY)[0]!.price).toBeNull();
    const some = { ...haircut, dateOverrides: { "2026-11-23": 60 } };
    expect(changesOn([some], "2026-11-23", TODAY)[0]!.price).toBeNull();
  });
});

describe("changedDays - the days the month marks", () => {
  it("every changed day from today on, across services, and none that passed", () => {
    expect([...changedDays([haircut, beard, plain], "2026-11-25")].sort()).toEqual([
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
    ]);
    expect(changedDays([plain], TODAY).size).toBe(0);
  });
});

describe("changeSignature", () => {
  it("ignores the order staff were picked in and space around a name", () => {
    expect(changeSignature({ w: [], staff: ["b", "a"], n: " Week " })).toBe(
      changeSignature({ w: [], staff: ["a", "b"], n: "Week" }),
    );
    expect(changeSignature({ w: [], staff: [] })).toBe(changeSignature({ w: [], staff: [], n: "  " }));
  });
});

describe("what the bar says", () => {
  const base: DayChange = {
    serviceId: "svc1",
    serviceName: "Haircut",
    dates: ["2026-11-23"],
    hours: early.w,
    staffIds: [],
    name: null,
    price: null,
  };

  it("an unnamed change goes by its service, with the hours under it", () => {
    expect(changeTitle(base)).toBe("Haircut");
    expect(changeSub(base)).toBe("Own hours: 8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM");
  });

  it("a named change goes by its name, and the service moves down a line", () => {
    const named = { ...base, name: "Holiday week" };
    expect(changeTitle(named)).toBe("Holiday week");
    expect(changeSub(named)).toBe("Haircut · 8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM");
  });

  it("a day the service is not offered says so, named or not", () => {
    const closed = { ...base, hours: [] };
    expect(changeTitle(closed)).toBe("Haircut closed");
    expect(changeSub(closed)).toBe("Not offered this day");
    expect(changeSub({ ...closed, name: "Family day" })).toBe("Haircut · not offered");
  });

  it("names the people when the change is for some of them", () => {
    expect(changeSub(base, ["Avery"])).toBe("Own hours: 8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM · with Avery");
  });
});

describe("changeHours - rows the planner must draw", () => {
  it("the first and last hour of each set of hours", () => {
    const six = { serviceId: "s", serviceName: "S", dates: [], staffIds: [], name: null, price: null };
    expect(changeHours([{ ...six, hours: [{ s: 360, e: 600 }] }])).toEqual([6, 9]);
    // Ends on the hour: the last row is the hour before, not the hour it ends at.
    expect(changeHours([{ ...six, hours: [{ s: 390, e: 1440 }] }])).toEqual([6, 23]);
    expect(changeHours([{ ...six, hours: [] }])).toEqual([]);
  });
});
