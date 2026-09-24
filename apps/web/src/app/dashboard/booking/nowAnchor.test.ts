import { describe, expect, it } from "vitest";
import { nowAnchorHour } from "./nowAnchor";
import type { AgendaRow } from "./page";

/**
 * Which row a planner showing today opens on. The DOM half (that the page
 * actually scrolls there, once, and only for today) is CalendarOpensAtNow.
 *
 * Instants here are UTC and `hourOf` reads UTC, so "14:40" is simply 2:40 PM
 * on the shop's clock - the zone conversion is the calendar's job, not this.
 */
const DAY = "2026-09-23";
const hourOf = (iso: string) => new Date(iso).getUTCHours();
const at = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00.000Z`);

type Row = Pick<AgendaRow, "source" | "status" | "start" | "end">;
function booking(from: string, to: string | null, over: Partial<Row> = {}): Row {
  return {
    source: "visit",
    status: "upcoming",
    start: new Date(at(from)).toISOString(),
    end: to === null ? null : new Date(at(to)).toISOString(),
    ...over,
  };
}

/** The planner's default window, 8 AM to 11 PM, one row per hour. */
const EVERY_HOUR = Array.from({ length: 16 }, (_, i) => 8 + i);

describe("the booking in progress comes first", () => {
  it("🔴 opens on the row of the booking he is in the middle of", () => {
    const rows = [
      booking("10:00", "10:45", { status: "completed" }),
      booking("14:15", "15:15"),
      booking("16:00", "16:30"),
    ];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:40"))).toBe(14);
  });

  it("uses the row the booking STARTED in, even from a later hour", () => {
    // A long colour job started at 1:30; at 2:40 it is still the one in the
    // chair, and it lives in the 1 PM row.
    const rows = [booking("13:30", "15:00"), booking("16:00", "16:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:40"))).toBe(13);
  });

  it("two chairs busy at once: the one that started first, so both are on screen", () => {
    const rows = [booking("14:15", "15:15"), booking("13:30", "15:00")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:40"))).toBe(13);
  });

  it("counts from the first minute and stops at the last", () => {
    const rows = [booking("14:15", "15:15"), booking("17:00", "17:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:15"))).toBe(14);
    // Over at 3:15 exactly - by then the next booking is what matters.
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("15:15"))).toBe(17);
  });
});

describe("otherwise the next booking today", () => {
  it("opens on what is coming up", () => {
    const rows = [booking("14:15", "15:15"), booking("16:00", "16:30"), booking("19:00", "19:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("15:30"))).toBe(16);
  });

  it("before the day starts, that is the first booking", () => {
    const rows = [booking("09:30", "10:00"), booking("13:00", "13:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("07:05"))).toBe(9);
  });
});

describe("otherwise the current hour", () => {
  it("nothing left today: opens on now", () => {
    const rows = [booking("14:15", "15:15"), booking("16:00", "16:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("17:10"))).toBe(17);
  });

  it("an empty day opens on now too", () => {
    expect(nowAnchorHour([], EVERY_HOUR, hourOf, at("11:20"))).toBe(11);
  });

  it("🔴 an hour folded into a blocked band opens on the band", () => {
    // A 5-9 PM block: its card sits in the 5 PM row, and the empty hours it
    // covers (6, 7, 8 PM) are ONE band row that starts at 6. At 7:30 the
    // 7 PM row does not exist - the band is what is on screen for it.
    const rowStarts = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23];
    const rows = [booking("17:00", "21:00", { source: "block", status: "blocked" })];
    expect(nowAnchorHour(rows, rowStarts, hourOf, at("19:30"))).toBe(18);
    expect(nowAnchorHour(rows, rowStarts, hourOf, at("18:05"))).toBe(18);
    // ...and once the block lets up, the hour has its own row again.
    expect(nowAnchorHour(rows, rowStarts, hourOf, at("21:10"))).toBe(21);
  });

  it("before the first row (6 AM on a day that opens at 8) opens on the first row", () => {
    expect(nowAnchorHour([], EVERY_HOUR, hourOf, at("06:10"))).toBe(8);
  });
});

describe("what is never 'the appointment I'm at'", () => {
  it("🔴 blocks, cancellations and no-shows are skipped", () => {
    const rows = [
      booking("14:00", "16:00", { source: "block", status: "blocked" }),
      booking("14:15", "15:15", { status: "canceled" }),
      booking("14:00", "15:00", { status: "no_show" }),
      booking("16:00", "16:30"),
    ];
    // Each of the first three spans 2:40 PM; none of them is the chair.
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:40"))).toBe(16);
  });

  it("a later cancellation is not 'next' either", () => {
    const rows = [booking("15:00", "15:30", { status: "canceled" }), booking("18:00", "18:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:40"))).toBe(18);
  });

  it("a booking with no end, or no length, is never running", () => {
    // Synced visits can arrive like this; without an end there is no way to
    // say it is still going, so the next real booking wins.
    const rows = [booking("14:00", null), booking("14:10", "14:10"), booking("16:00", "16:30")];
    expect(nowAnchorHour(rows, EVERY_HOUR, hourOf, at("14:40"))).toBe(16);
  });
});

it("no rows to scroll to is null, not a crash", () => {
  expect(nowAnchorHour([], [], hourOf, at("14:40"))).toBeNull();
});
