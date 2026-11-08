import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { targetedSlotHoursConflicts, type TargetedSlotForHours } from "./targetedSlotHoursConflicts";

const TZ = "America/New_York";
// 2099-01-05 and 2099-01-12 are Mondays.
const onDay = (d: number, min: number) => zonedWallTimeToUtc(2099, 0, d, min, TZ).toISOString();

function slot(over: Partial<TargetedSlotForHours> = {}): TargetedSlotForHours {
  return {
    staffId: "st1",
    serviceId: "haircut",
    serviceIds: ["haircut"],
    label: "After Hours Haircut",
    startsAt: onDay(5, 20 * 60),
    durationMin: 30,
    active: true,
    booked: false,
    ...over,
  };
}

function conflicts(slots: TargetedSlotForHours[], durationMin = 90, staffIds = ["st1"]) {
  return targetedSlotHoursConflicts({
    // Mon 9:00-10:30 AM and 7:00-8:30 PM.
    windowsByDay: { 1: [{ startMin: 540, endMin: 630 }, { startMin: 1140, endMin: 1230 }] },
    durationFor: () => durationMin,
    slots,
    serviceId: "retwist",
    staffIds,
    timezone: TZ,
  });
}

describe("targetedSlotHoursConflicts", () => {
  it("🔴 a 90 minute window at 7:00 PM with another service's slot at 8:00 PM loses 7:00", () => {
    expect(conflicts([slot()])).toEqual([
      {
        weekday: 1,
        staffId: "st1",
        lostStartMin: 1140,
        slotStartMin: 1200,
        slotLabel: "After Hours Haircut",
        nextDate: "2099-01-05",
      },
    ]);
  });

  it("a slot that ends before the window, or starts as it ends, costs nothing", () => {
    expect(conflicts([slot({ startsAt: onDay(5, 18 * 60), durationMin: 60 })])).toEqual([]);
    expect(conflicts([slot({ startsAt: onDay(5, 20 * 60 + 30) })])).toEqual([]);
  });

  it("a shorter service loses only the start the slot covers", () => {
    expect(conflicts([slot()], 30).map((c) => c.lostStartMin)).toEqual([1200]);
    expect(conflicts([slot({ startsAt: onDay(5, 20 * 60 + 15), durationMin: 15 })], 60)).toEqual([]);
  });

  it("a paused slot, a booked slot and another barber's slot do not count", () => {
    expect(conflicts([slot({ active: false })])).toEqual([]);
    expect(conflicts([slot({ booked: true })])).toEqual([]);
    expect(conflicts([slot({ staffId: "st2" })])).toEqual([]);
  });

  it("a slot selling this same service at that start still offers the time", () => {
    expect(
      conflicts([slot({ serviceId: "retwist", serviceIds: ["retwist"], startsAt: onDay(5, 19 * 60) })]),
    ).toEqual([]);
  });

  it("the same clash every week is one line, dated with the soonest", () => {
    const found = conflicts([slot({ startsAt: onDay(12, 20 * 60) }), slot()]);
    expect(found).toHaveLength(1);
    expect(found[0]!.nextDate).toBe("2099-01-05");
  });

  it("a weekday with no window is never reported", () => {
    expect(conflicts([slot({ startsAt: onDay(6, 20 * 60) })])).toEqual([]);
  });
});
