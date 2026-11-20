import { describe, expect, it } from "vitest";
import type { DayBundlesResult, DayService } from "./actions";
import { narrowDayToStaff, offersChoice, pickablePeople, worksOn } from "./barberFilter";
import { dayHasTimes, dayMenuGroups } from "./dayMenu";

const T3 = "2026-03-02T15:00:00.000Z";
const T4 = "2026-03-02T16:00:00.000Z";

function svc(id: string, slots: DayService["slots"]): DayService {
  return { id, name: id, description: null, imageUrl: null, color: null, durationMin: 30, price: 40, slots };
}

/** Ana does cuts and colour, Ben only cuts. */
const offers = (who: string) => (serviceId: string) =>
  who === "ana" ? ["cut", "colour", "shave"].includes(serviceId) : serviceId === "cut";

function day(): DayBundlesResult {
  return {
    timezone: "UTC",
    date: "2026-03-02",
    bundles: [
      {
        id: "g_hair",
        name: "Hair",
        position: 0,
        services: [
          svc("cut", [
            { startsAt: T3, staffIds: ["ben", "ana"] },
            { startsAt: T4, staffIds: ["ana"] },
          ]),
          svc("colour", [{ startsAt: T3, staffIds: ["ana"] }]),
        ],
      },
    ],
    closedGroups: [{ id: "g_face", name: "Face", position: 1, services: [svc("shave", [])] }],
    ungrouped: [svc("colour", [{ startsAt: T4, staffIds: ["ana"], targeted: { id: "t1", price: 20, label: null } }])],
  };
}

describe("narrowDayToStaff - one day as one person offers it", () => {
  it("🔴 keeps only that person's times and pins each to them", () => {
    const out = narrowDayToStaff(day(), "ben", offers("ben"));
    expect(out.bundles).toHaveLength(1);
    expect(out.bundles[0]!.services.map((s) => s.id)).toEqual(["cut"]);
    // 3:00 was open with both; for Ben it is Ben's alone. 4:00 was Ana's.
    expect(out.bundles[0]!.services[0]!.slots).toEqual([{ startsAt: T3, staffIds: ["ben"] }]);
  });

  it("🔴 a time shared with someone else is never left carrying the other person", () => {
    const out = narrowDayToStaff(day(), "ana", offers("ana"));
    const all = [...out.bundles.flatMap((b) => b.services), ...out.ungrouped].flatMap((s) => s.slots);
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(s.staffIds).toEqual(["ana"]);
  });

  it("drops a loose service they have no time for, and keeps a special that is theirs", () => {
    expect(narrowDayToStaff(day(), "ben", offers("ben")).ungrouped).toEqual([]);
    const ana = narrowDayToStaff(day(), "ana", offers("ana")).ungrouped;
    expect(ana).toHaveLength(1);
    expect(ana[0]!.slots[0]!.targeted).toEqual({ id: "t1", price: 20, label: null });
  });

  it("a group left with no times becomes a closed card listing only what they do", () => {
    const d = day();
    // Nobody but Ana is free for anything in Hair.
    d.bundles[0]!.services[0]!.slots = [{ startsAt: T4, staffIds: ["ana"] }];
    const out = narrowDayToStaff(d, "ben", offers("ben"));
    expect(out.bundles).toEqual([]);
    const groups = dayMenuGroups(out);
    expect(groups.map((g) => [g.name, g.closed])).toEqual([["Hair", true]]);
    expect(groups[0]!.services.map((s) => s.id)).toEqual(["cut"]);
    expect(dayHasTimes(out)).toBe(false);
  });

  it("a group they do nothing in is not shown at all, open or closed", () => {
    const ben = narrowDayToStaff(day(), "ben", offers("ben"));
    expect(ben.closedGroups!.map((g) => g.name)).toEqual([]);
    const ana = narrowDayToStaff(day(), "ana", offers("ana"));
    expect(ana.closedGroups!.map((g) => g.name)).toEqual(["Face"]);
  });

  it("does not change the day it was given", () => {
    const d = day();
    const before = JSON.stringify(d);
    narrowDayToStaff(d, "ben", offers("ben"));
    expect(JSON.stringify(d)).toBe(before);
  });

  it("an API that sends no closedGroups still narrows", () => {
    const { closedGroups: _gone, ...old } = day();
    const out = narrowDayToStaff(old, "ben", offers("ben"));
    expect(out.bundles[0]!.services.map((s) => s.id)).toEqual(["cut"]);
  });
});

describe("pickablePeople / offersChoice - who a customer may choose", () => {
  const offerings = [
    { serviceId: "cut", staffId: "ana" },
    { serviceId: "cut", staffId: "ben" },
    { serviceId: "hidden", staffId: "cy" },
  ];
  const menu = new Set(["cut"]);

  it("lists people who do something on the menu and keep hours", () => {
    const staff = [
      { id: "ana", weekdays: [1, 2] },
      { id: "ben", weekdays: [3] },
      { id: "cy", weekdays: [1] }, // only does a service clients cannot see
      { id: "dee", weekdays: [1] }, // does nothing
    ];
    expect(pickablePeople(staff, offerings, menu).map((s) => s.id)).toEqual(["ana", "ben"]);
  });

  it("leaves out someone with no hours on any day", () => {
    const staff = [
      { id: "ana", weekdays: [1] },
      { id: "ben", weekdays: [] },
    ];
    expect(pickablePeople(staff, offerings, menu).map((s) => s.id)).toEqual(["ana"]);
  });

  it("an API that sends no weekdays is trusted on hours", () => {
    expect(pickablePeople([{ id: "ana" }, { id: "ben" }], offerings, menu)).toHaveLength(2);
  });

  it("🔴 one person is not a choice; two are", () => {
    expect(offersChoice([])).toBe(false);
    expect(offersChoice(["ana"])).toBe(false);
    expect(offersChoice(["ana", "ben"])).toBe(true);
  });
});

describe("worksOn - the days the calendar offers for one person", () => {
  // 2026-03-02 is a Monday.
  it("is true only on a weekday they keep hours", () => {
    expect(worksOn({ id: "a", weekdays: [1] }, "2026-03-02")).toBe(true);
    expect(worksOn({ id: "a", weekdays: [2, 3] }, "2026-03-02")).toBe(false);
  });
  it("is true for nobody chosen, and for a person whose days the API did not send", () => {
    expect(worksOn(null, "2026-03-02")).toBe(true);
    expect(worksOn({ id: "a" }, "2026-03-02")).toBe(true);
  });
});
