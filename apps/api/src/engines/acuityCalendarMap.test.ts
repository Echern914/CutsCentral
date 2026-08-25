/**
 * The mapping gate decides whether real Acuity writes are allowed, so every
 * branch is proven here without a database.
 */
import { describe, expect, it } from "vitest";
import {
  computeMappingReadiness,
  isMappingStale,
  type StaffMappingRow,
} from "./acuityCalendarMap.js";
import type { AcuityCalendar } from "../acuity/types.js";

const CONNECTED = new Date("2026-08-01T00:00:00Z");

function chair(over: Partial<StaffMappingRow> = {}): StaffMappingRow {
  return {
    id: "staff_1",
    name: "Drick",
    active: true,
    bookable: true,
    acuityCalendarId: "cal_1",
    acuityCalendarMappedAt: new Date("2026-08-02T00:00:00Z"),
    ...over,
  };
}
const CALS: AcuityCalendar[] = [
  { id: "cal_1", name: "Chair 1" } as AcuityCalendar,
  { id: "cal_2", name: "Chair 2" } as AcuityCalendar,
];

describe("isMappingStale", () => {
  it("a mapping saved BEFORE the current connection is stale", () => {
    expect(isMappingStale(new Date("2026-07-01T00:00:00Z"), CONNECTED)).toBe(true);
  });
  it("a mapping saved after is fresh", () => {
    expect(isMappingStale(new Date("2026-08-02T00:00:00Z"), CONNECTED)).toBe(false);
  });
  it("no mappedAt at all is stale - we cannot prove which account it meant", () => {
    expect(isMappingStale(null, CONNECTED)).toBe(true);
  });
  it("not connected: staleness is not the question", () => {
    expect(isMappingStale(null, null)).toBe(false);
  });
});

describe("computeMappingReadiness", () => {
  it("every bookable chair mapped and fresh => ready", () => {
    const r = computeMappingReadiness({
      staff: [chair(), chair({ id: "s2", acuityCalendarId: "cal_2" })],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.ready).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });

  it("an UNMAPPED bookable chair blocks enforcement shop-wide", () => {
    const r = computeMappingReadiness({
      staff: [chair(), chair({ id: "s2", acuityCalendarId: null })],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.ready).toBe(false);
    expect(r.blocking.map((s) => s.problem)).toEqual(["unmapped"]);
  });

  it("a calendar no longer on the account is INVALID, not merely stale", () => {
    const r = computeMappingReadiness({
      staff: [chair({ acuityCalendarId: "cal_deleted" })],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.blocking[0]!.problem).toBe("invalid");
  });

  it("a mapping predating a RECONNECT is stale - the id may be another account's chair", () => {
    const r = computeMappingReadiness({
      staff: [chair({ acuityCalendarMappedAt: new Date("2026-07-01T00:00:00Z") })],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.ready).toBe(false);
    expect(r.blocking[0]!.problem).toBe("stale");
  });

  it("an INACTIVE or serviceless chair never blocks - it cannot be booked", () => {
    const r = computeMappingReadiness({
      staff: [
        chair(),
        chair({ id: "s2", active: false, bookable: false, acuityCalendarId: null }),
        chair({ id: "s3", bookable: false, acuityCalendarId: null }),
      ],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.ready).toBe(true);
    expect(r.staff.filter((s) => s.problem === "unmapped")).toHaveLength(2);
  });

  it("a shop with NO bookable chair is not 'ready' - there is nothing to protect", () => {
    const r = computeMappingReadiness({
      staff: [chair({ bookable: false })],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.ready).toBe(false);
  });

  it("one chair + one calendar preselects, but only while still unmapped", () => {
    const one = [CALS[0]!];
    const unmapped = computeMappingReadiness({
      staff: [chair({ acuityCalendarId: null })],
      calendars: one,
      connectedAt: CONNECTED,
    });
    expect(unmapped.preselectCalendarId).toBe("cal_1");

    const already = computeMappingReadiness({
      staff: [chair()],
      calendars: one,
      connectedAt: CONNECTED,
    });
    expect(already.preselectCalendarId).toBeNull();
  });

  it("never preselects when the shape is ambiguous (2 chairs, or 2 calendars)", () => {
    expect(
      computeMappingReadiness({
        staff: [chair({ acuityCalendarId: null }), chair({ id: "s2", acuityCalendarId: null })],
        calendars: [CALS[0]!],
        connectedAt: CONNECTED,
      }).preselectCalendarId,
    ).toBeNull();
    expect(
      computeMappingReadiness({
        staff: [chair({ acuityCalendarId: null })],
        calendars: CALS,
        connectedAt: CONNECTED,
      }).preselectCalendarId,
    ).toBeNull();
  });

  it("reports the live calendar NAME so the owner can match chairs by eye", () => {
    const r = computeMappingReadiness({
      staff: [chair()],
      calendars: CALS,
      connectedAt: CONNECTED,
    });
    expect(r.staff[0]!.calendarName).toBe("Chair 1");
  });
});
