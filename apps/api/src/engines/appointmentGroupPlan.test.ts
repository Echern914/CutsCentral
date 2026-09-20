import { describe, expect, it } from "vitest";
import {
  GroupPlanError,
  MAX_GROUP_ATTENDEES,
  groupExtraDurationMin,
  planGroupSequence,
  type GroupPlanService,
} from "./appointmentGroup.js";

/**
 * Who sits when, and what the visit costs.
 *
 * Pure: no database, no clock, no transaction. Every number a customer is shown
 * before they confirm comes out of this function, so it is worth pinning
 * precisely rather than through an HTTP round trip.
 *
 * 🔴 FIXED PAST INSTANTS throughout. A hard-coded future date goes red on every
 * branch the day it passes, and these assertions are about exact wall-clock
 * sequences that must not move.
 */
const TZ = "America/New_York";
/** 2026-03-14T18:00:00Z = 2:00 PM in New York (EDT). A Saturday. */
const TWO_PM = new Date("2026-03-14T18:00:00.000Z");

function service(
  id: string,
  name: string,
  durationMin: number,
  price: number | null,
  over: Partial<GroupPlanService> = {},
): GroupPlanService & { name: string } {
  return {
    id,
    name,
    durationMin,
    price,
    durationOverrides: null,
    priceOverrides: null,
    dateOverrides: null,
    timeOverrides: null,
    ...over,
  };
}

const HAIRCUT = service("svc_cut", "Haircut", 30, 40);
const KIDS = service("svc_kids", "Kids cut", 20, 25);
const BEARD = service("svc_beard", "Beard trim", 15, 15);

const MENU = new Map([
  [HAIRCUT.id, HAIRCUT],
  [KIDS.id, KIDS],
  [BEARD.id, BEARD],
]);

const plan = (attendees: Array<[string, string]>, startsAt = TWO_PM) =>
  planGroupSequence({
    attendees: attendees.map(([firstName, serviceId]) => ({ firstName, serviceId })),
    startsAt,
    timezone: TZ,
    services: MENU,
  });

/** "2:00-2:30" in the shop's zone, for readable assertions. */
const at = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
const span = (m: { startsAt: Date; endsAt: Date }) => `${at(m.startsAt)}-${at(m.endsAt)}`;

describe("one attendee is an ordinary booking", () => {
  it("🔴 quantity 1 is just the appointment, unchanged", () => {
    // The group path must not become a second, subtly different way to book one
    // person. One attendee = one member, starting exactly when asked, ending
    // exactly one service later.
    const p = plan([["Eric", HAIRCUT.id]]);
    expect(p.members).toHaveLength(1);
    expect(span(p.members[0]!)).toBe("2:00 PM-2:30 PM");
    expect(p.startsAt).toEqual(TWO_PM);
    expect(p.endsAt).toEqual(p.members[0]!.endsAt);
    expect(p.totalDurationMin).toBe(30);
    expect(p.totalPriceCents).toBe(4000);
  });

  it("asks the availability grid for no extra room", () => {
    expect(groupExtraDurationMin(plan([["Eric", HAIRCUT.id]]))).toBe(0);
  });
});

describe("two and three attendees sit back to back", () => {
  it("🔴 the second starts exactly when the first ends - no gap, no buffer", () => {
    // The shop's turnover buffer spaces out DIFFERENT parties. These people
    // arrived together; the whole point is that the second sits down as the
    // first gets up. A buffer here would put a hole in their own visit.
    const p = plan([
      ["Eric", HAIRCUT.id],
      ["Brother", KIDS.id],
    ]);
    expect(p.members.map(span)).toEqual(["2:00 PM-2:30 PM", "2:30 PM-2:50 PM"]);
    expect(p.members[1]!.startsAt).toEqual(p.members[0]!.endsAt);
  });

  it("names the attendee and the service for each seat", () => {
    const p = plan([
      ["Eric", HAIRCUT.id],
      ["Brother", KIDS.id],
    ]);
    expect(p.members.map((m) => [m.firstName, m.serviceName, m.position])).toEqual([
      ["Eric", "Haircut", 0],
      ["Brother", "Kids cut", 1],
    ]);
  });

  it("🔴 different durations produce the right sequence AND the right total", () => {
    const p = plan([
      ["Eric", HAIRCUT.id], // 30
      ["Brother", KIDS.id], // 20
      ["Dad", BEARD.id], // 15
    ]);
    expect(p.members.map(span)).toEqual([
      "2:00 PM-2:30 PM",
      "2:30 PM-2:50 PM",
      "2:50 PM-3:05 PM",
    ]);
    expect(p.totalDurationMin).toBe(65);
    expect(p.endsAt.getTime() - p.startsAt.getTime()).toBe(65 * 60_000);
    // 40 + 25 + 15
    expect(p.totalPriceCents).toBe(8000);
  });

  it("asks the grid for the rest of the run, stepped by the FIRST service", () => {
    // 🔴 Not the combined total. Re-stepping the grid by 65 minutes would reject
    // most start times the picker already offers, and the barber's day would
    // appear to empty out as the customer added people.
    const p = plan([
      ["Eric", HAIRCUT.id],
      ["Brother", KIDS.id],
      ["Dad", BEARD.id],
    ]);
    expect(groupExtraDurationMin(p)).toBe(35); // 65 total - 30 first
  });

  it("the same service three times still lays out correctly", () => {
    const p = plan([
      ["A", HAIRCUT.id],
      ["B", HAIRCUT.id],
      ["C", HAIRCUT.id],
    ]);
    expect(p.members.map(span)).toEqual([
      "2:00 PM-2:30 PM",
      "2:30 PM-3:00 PM",
      "3:00 PM-3:30 PM",
    ]);
    expect(p.totalPriceCents).toBe(12000);
  });
});

describe("🔴 a duration is resolved at ITS OWN start, not the group's", () => {
  it("a per-weekday override applies to the member it actually lands on", () => {
    // Services carry per-weekday duration overrides. The obvious implementation
    // resolves every duration up front against the GROUP start, which is wrong
    // the moment a run crosses shop-local midnight - and wrong silently: the
    // sequence looks plausible and the last appointment is the wrong length.
    //
    // 11:45 PM Saturday + a 30-min cut lands the second member at 12:15 AM
    // SUNDAY, where this service is 60 minutes rather than 30.
    const sundayLong = service("svc_var", "Variable", 30, 40, {
      durationOverrides: { 0: 60 }, // 0 = Sunday
    });
    const menu = new Map([[sundayLong.id, sundayLong]]);
    const p = planGroupSequence({
      attendees: [
        { firstName: "Sat", serviceId: sundayLong.id },
        { firstName: "Sun", serviceId: sundayLong.id },
      ],
      // 2026-03-15T03:45:00Z = 11:45 PM Saturday in New York.
      startsAt: new Date("2026-03-15T03:45:00.000Z"),
      timezone: TZ,
      services: menu,
    });
    expect(p.members[0]!.durationMin).toBe(30); // Saturday
    expect(p.members[1]!.durationMin).toBe(60); // Sunday, resolved at 12:15 AM
    expect(p.totalDurationMin).toBe(90);
  });
});

describe("a price that was never set is not a price of zero", () => {
  it("🔴 reports unpriced members instead of quoting a total the shop never agreed", () => {
    const free = service("svc_none", "Consultation", 10, null);
    const menu = new Map([
      [HAIRCUT.id, HAIRCUT],
      [free.id, free],
    ]);
    const p = planGroupSequence({
      attendees: [
        { firstName: "Eric", serviceId: HAIRCUT.id },
        { firstName: "Brother", serviceId: free.id },
      ],
      startsAt: TWO_PM,
      timezone: TZ,
      services: menu,
    });
    expect(p.members[1]!.priceCents).toBeNull();
    expect(p.totalPriceCents).toBe(4000); // the haircut only
    // The caller must be able to say "plus one service priced in shop".
    expect(p.unpricedCount).toBe(1);
  });
});

describe("what the planner refuses", () => {
  it("refuses more than three attendees", () => {
    expect(MAX_GROUP_ATTENDEES).toBe(3);
    expect(() =>
      plan([
        ["A", HAIRCUT.id],
        ["B", HAIRCUT.id],
        ["C", HAIRCUT.id],
        ["D", HAIRCUT.id],
      ]),
    ).toThrow(GroupPlanError);
  });

  it("refuses an empty group", () => {
    expect(() => plan([])).toThrow(GroupPlanError);
  });

  it("refuses a service this shop does not offer", () => {
    // The caller builds the map from the shop's OWN services, so a miss here is
    // an id from somewhere else. Refusing beats booking a blank 0-minute seat.
    expect(() => plan([["Eric", "svc_from_another_shop"]])).toThrow(GroupPlanError);
  });

  it("refuses a blank attendee name", () => {
    // The name is what the barber reads off the calendar to call someone over.
    expect(() => plan([["   ", HAIRCUT.id]])).toThrow(GroupPlanError);
  });

  it("trims the name it keeps", () => {
    expect(plan([["  Eric  ", HAIRCUT.id]]).members[0]!.firstName).toBe("Eric");
  });
});
