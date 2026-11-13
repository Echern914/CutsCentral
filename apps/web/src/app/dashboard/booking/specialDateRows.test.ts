import { describe, expect, it } from "vitest";
import type { SpecialDayRow, TargetedSlotRow } from "./actions";
import type { ServiceRow } from "./page";
import {
  buildSpecialDates,
  byMonth,
  holidayGroups,
  holidayRuns,
  priceWords,
  rangeLabel,
} from "./specialDateRows";

/**
 * One list of every date that runs differently. These are the rows it makes
 * out of the four places such a date is stored. "Today" is handed in, so no
 * date here can go stale on the real calendar.
 */

const TODAY = "2026-11-13";
const TZ = "America/New_York";

function svc(over: Partial<ServiceRow> & { id: string; name: string }): ServiceRow {
  return {
    description: null,
    imageUrl: null,
    durationMin: 30,
    price: 40,
    priceOverrides: {},
    dateOverrides: {},
    durationOverrides: {},
    dailyLimits: {},
    hoursWindows: {},
    timeOverrides: [],
    color: null,
    offeredByAll: true,
    active: true,
    visibility: "public",
    sortOrder: 0,
    dailyTarget: null,
    staffIds: [],
    serviceGroupId: null,
    ...over,
  } as ServiceRow;
}

const staff = [
  { id: "st1", name: "Avery" },
  { id: "st2", name: "Sam" },
];

function build(over: Partial<Parameters<typeof buildSpecialDates>[0]> = {}) {
  return buildSpecialDates({
    services: [],
    staff,
    names: {},
    specialDays: [],
    slots: [],
    rules: [],
    today: TODAY,
    timezone: TZ,
    ...over,
  });
}

function slot(over: Partial<TargetedSlotRow> & { id: string; startsAt: string }): TargetedSlotRow {
  return {
    staffId: "st1",
    serviceId: "cut",
    label: null,
    durationMin: 30,
    price: 80,
    active: true,
    ruleId: null,
    booked: false,
    ...over,
  };
}

function day(over: Partial<SpecialDayRow> & { date: string }): SpecialDayRow {
  return {
    ruleId: "r1",
    staffId: "st1",
    name: null,
    price: 65,
    cutMin: 20,
    firstStart: null,
    lastEnd: null,
    openings: 12,
    booked: 0,
    ...over,
  };
}

describe("rangeLabel", () => {
  it("names the month once, and again only when it changes", () => {
    expect(rangeLabel("2026-11-26", "2026-11-26")).toBe("Nov 26");
    expect(rangeLabel("2026-12-25", "2026-12-31")).toBe("Dec 25 – 31");
    expect(rangeLabel("2026-12-30", "2027-01-02")).toBe("Dec 30 – Jan 2");
  });
});

describe("holiday runs", () => {
  const services = [
    svc({ id: "cut", name: "Cut", dateOverrides: { "2026-12-24": 65, "2026-12-25": 65, "2026-12-26": 70 } }),
    svc({ id: "beard", name: "Beard", dateOverrides: { "2026-12-24": 65, "2026-12-25": 65 } }),
  ];

  it("days priced alike under one name are one run; a different price splits it", () => {
    const runs = holidayRuns(holidayGroups(services), {});
    expect(runs.map((r) => [r.from, r.to])).toEqual([
      ["2026-12-24", "2026-12-25"],
      ["2026-12-26", "2026-12-26"],
    ]);
  });

  it("a different NAME splits days priced alike", () => {
    const runs = holidayRuns(holidayGroups(services), { "2026-12-24": "Christmas Eve", "2026-12-25": "Christmas" });
    expect(runs.map((r) => r.from)).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
  });
});

describe("priceWords", () => {
  const e = (serviceId: string, price: number) => ({ serviceId, serviceName: serviceId, price });

  it("says Every service only when every ACTIVE service has that one price", () => {
    expect(priceWords([e("a", 65), e("b", 65)], ["a", "b"])).toBe("Every service $65");
    expect(priceWords([e("a", 65), e("b", 65)], ["a", "b", "c"])).toBe("2 services $65");
  });

  it("lists them when prices differ, and counts past two", () => {
    expect(priceWords([e("Cut", 60), e("Beard", 25)], ["Cut", "Beard"])).toBe("Cut $60, Beard $25");
    expect(priceWords([e("Cut", 60), e("Beard", 25), e("Kids", 30)], [])).toBe("Cut $60, Beard $25 +1");
  });

  it("one service is named, never called Every service", () => {
    expect(priceWords([e("Cut", 60)], ["Cut"])).toBe("Cut $60");
  });
});

describe("a different price on a date", () => {
  const services = [
    svc({ id: "cut", name: "Cut", dateOverrides: { "2026-11-26": 75, "2026-10-01": 50 } }),
    svc({ id: "beard", name: "Beard", dateOverrides: { "2026-11-26": 75 } }),
  ];

  it("a named date leads with its name; a passed one is not listed", () => {
    const rows = build({ services, names: { "2026-11-26": "Thanksgiving" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "price",
      date: "2026-11-26",
      title: "Thanksgiving",
      sub: "Every service $75",
      target: { kind: "price", dates: ["2026-11-26"] },
    });
  });

  it("an unnamed one leads with the price", () => {
    const rows = build({ services });
    expect(rows[0]).toMatchObject({ title: "Every service $75", sub: "A different price that day" });
  });

  it("a stretch already under way shows from today, and opens the WHOLE saved stretch", () => {
    const week = svc({
      id: "cut",
      name: "Cut",
      dateOverrides: { "2026-11-12": 60, "2026-11-13": 60, "2026-11-14": 60 },
    });
    const rows = build({ services: [week] });
    expect(rows[0]).toMatchObject({
      date: "2026-11-13",
      dates: ["2026-11-13", "2026-11-14"],
      title: "Cut $60",
      sub: "Nov 13 – 14",
      target: { kind: "price", dates: ["2026-11-12", "2026-11-13", "2026-11-14"] },
    });
  });
});

describe("a special day", () => {
  it("puts every staff member's day on one date into one row", () => {
    const rows = build({
      specialDays: [
        day({
          date: "2026-11-26",
          name: "Thanksgiving",
          firstStart: "2026-11-26T14:00:00.000Z",
          lastEnd: "2026-11-26T22:00:00.000Z",
          booked: 2,
        }),
        day({
          date: "2026-11-26",
          name: "Thanksgiving",
          ruleId: "r2",
          staffId: "st2",
          price: 80,
          firstStart: "2026-11-26T15:00:00.000Z",
          lastEnd: "2026-11-26T23:00:00.000Z",
          openings: 8,
          booked: 1,
        }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "day",
      title: "Thanksgiving",
      // The shop's clock, not the server's: 14:00Z is 9 AM in New York.
      sub: "9:00 AM – 6:00 PM · 20 openings · $65 – $80 · 3 booked",
      target: { kind: "day", date: "2026-11-26", name: "Thanksgiving" },
    });
  });

  it("an unnamed one is called Special day, and one opening is not 'openings'", () => {
    const rows = build({ specialDays: [day({ date: "2026-12-01", openings: 1 })] });
    expect(rows[0]).toMatchObject({ title: "Special day", sub: "1 opening · $65" });
  });

  it("a passed one is not listed", () => {
    expect(build({ specialDays: [day({ date: "2026-11-12" })] })).toEqual([]);
  });
});

describe("one service's own hours on a date", () => {
  const longer = { w: [{ s: 480, e: 1260 }], staff: [] };

  it("days set the same way are one row, even with a gap between them", () => {
    const rows = build({
      services: [
        svc({
          id: "cut",
          name: "Haircut",
          dateHours: {
            "2026-11-23": longer,
            "2026-11-24": longer,
            "2026-11-25": longer,
            "2026-11-27": longer,
          },
        }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "hours",
      date: "2026-11-23",
      title: "Haircut",
      sub: "8:00 AM – 9:00 PM · Mon Nov 23, Tue 24, Wed 25 and Fri 27",
      target: { kind: "hours", serviceId: "cut" },
    });
  });

  it("a closed day is its own row with its own chip", () => {
    const rows = build({
      services: [
        svc({
          id: "cut",
          name: "Haircut",
          dateHours: { "2026-11-25": longer, "2026-11-26": { w: [], staff: [] } },
        }),
      ],
    });
    expect(rows.map((r) => [r.kind, r.title, r.sub])).toEqual([
      ["hours", "Haircut", "8:00 AM – 9:00 PM"],
      ["closed", "Haircut closed", "Not offered that day"],
    ]);
  });

  it("says who, when the change is for some of the staff only", () => {
    const rows = build({
      services: [
        svc({ id: "cut", name: "Haircut", dateHours: { "2026-11-25": { w: [{ s: 480, e: 1260 }], staff: ["st2"] } } }),
      ],
    });
    expect(rows[0]!.sub).toBe("8:00 AM – 9:00 PM · with Sam");
  });

  it("a split day reads as both parts", () => {
    const rows = build({
      services: [
        svc({
          id: "cut",
          name: "Haircut",
          dateHours: {
            "2026-11-25": {
              w: [
                { s: 480, e: 720 },
                { s: 780, e: 1200 },
              ],
              staff: [],
            },
          },
        }),
      ],
    });
    expect(rows[0]!.sub).toBe("8:00 AM – 12:00 PM and 1:00 PM – 8:00 PM");
  });

  it("a passed day drops off, and the rest of its group stays", () => {
    const rows = build({
      services: [svc({ id: "cut", name: "Haircut", dateHours: { "2026-11-12": longer, "2026-11-13": longer } })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dates).toEqual(["2026-11-13"]);
  });
});

describe("a one-time opening", () => {
  const services = [svc({ id: "cut", name: "Haircut" })];

  it("says the time on the shop's clock, the service and the price", () => {
    const rows = build({ services, slots: [slot({ id: "t1", startsAt: "2026-11-21T02:30:00.000Z" })] });
    expect(rows[0]).toMatchObject({
      kind: "opening",
      // 02:30Z on the 21st is 9:30 PM on the 20th in New York.
      date: "2026-11-20",
      title: "One-time opening, 9:30 PM",
      sub: "Haircut · $80",
      target: { kind: "opening", slotId: "t1" },
    });
  });

  it("uses the barber's own name for it", () => {
    const rows = build({
      services,
      slots: [slot({ id: "t1", startsAt: "2026-11-21T02:30:00.000Z", label: "After hours" })],
    });
    expect(rows[0]!.title).toBe("After hours, 9:30 PM");
  });

  it("several on one day are one row", () => {
    const rows = build({
      services,
      slots: [
        slot({ id: "t2", startsAt: "2026-11-21T03:00:00.000Z", price: 90, booked: true }),
        slot({ id: "t1", startsAt: "2026-11-21T02:30:00.000Z" }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "2 one-time openings",
      sub: "9:30 PM, 10:00 PM · Haircut · $80 – $90 · 1 booked",
      // The soonest one is the one a tap opens.
      target: { kind: "opening", slotId: "t1" },
    });
  });

  it("says when it is booked, or turned off", () => {
    const at = "2026-11-21T02:30:00.000Z";
    expect(build({ services, slots: [slot({ id: "t1", startsAt: at, booked: true })] })[0]!.sub).toBe(
      "Haircut · $80 · Booked",
    );
    expect(build({ services, slots: [slot({ id: "t1", startsAt: at, active: false })] })[0]!.sub).toBe(
      "Haircut · $80 · Turned off",
    );
  });

  it("🔴 a weekly series is not a date: its slots are left out", () => {
    const rows = build({
      services,
      slots: [slot({ id: "t1", startsAt: "2026-11-21T02:30:00.000Z", ruleId: "rule1" })],
      rules: [{ id: "rule1" }],
    });
    expect(rows).toEqual([]);
  });

  it("what is left of a series that was turned off is listed on its own", () => {
    const rows = build({
      services,
      slots: [slot({ id: "t1", startsAt: "2026-11-21T02:30:00.000Z", ruleId: "gone", booked: true })],
    });
    expect(rows[0]).toMatchObject({ kind: "opening", sub: "Haircut · $80 · Booked" });
  });

  it("a passed one is not listed", () => {
    expect(build({ services, slots: [slot({ id: "t1", startsAt: "2026-11-12T02:30:00.000Z" })] })).toEqual([]);
  });
});

describe("the whole list", () => {
  it("runs soonest first, and on one date the biggest change comes first", () => {
    const rows = build({
      services: [
        svc({
          id: "cut",
          name: "Haircut",
          dateOverrides: { "2026-11-26": 75 },
          dateHours: { "2026-11-26": { w: [], staff: [] } },
        }),
      ],
      specialDays: [day({ date: "2026-11-26" })],
      slots: [
        slot({ id: "t1", startsAt: "2026-11-26T23:00:00.000Z" }),
        slot({ id: "t0", startsAt: "2026-11-20T23:00:00.000Z" }),
      ],
    });
    expect(rows.map((r) => `${r.date} ${r.kind}`)).toEqual([
      "2026-11-20 opening",
      "2026-11-26 closed",
      "2026-11-26 day",
      "2026-11-26 price",
      "2026-11-26 opening",
    ]);
  });

  it("every row has its own key", () => {
    const rows = build({
      services: [
        svc({ id: "cut", name: "Haircut", dateOverrides: { "2026-11-26": 75 } }),
        svc({ id: "kid", name: "Kids", dateHours: { "2026-11-26": { w: [], staff: [] } } }),
      ],
      specialDays: [day({ date: "2026-11-26" })],
      slots: [slot({ id: "t1", startsAt: "2026-11-26T23:00:00.000Z" })],
    });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("byMonth", () => {
  it("cuts the list into months and names the year once it is not this one", () => {
    const rows = build({
      services: [
        svc({
          id: "cut",
          name: "Haircut",
          dateOverrides: { "2026-11-26": 75, "2026-12-24": 80, "2027-01-01": 90 },
        }),
      ],
    });
    const months = byMonth(rows, TODAY);
    expect(months.map((m) => [m.key, m.label, m.entries.length])).toEqual([
      ["2026-11", "November", 1],
      ["2026-12", "December", 1],
      ["2027-01", "January 2027", 1],
    ]);
  });
});
