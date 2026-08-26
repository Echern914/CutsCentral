import { describe, expect, it } from "vitest";
import { dayTotals } from "./dayTotals";
import type { AgendaRow } from "./page";

const DAY = "2026-08-26";

function at(hhmm: string, mins: number, over: Partial<AgendaRow> = {}): AgendaRow {
  const start = `${DAY}T${hhmm}:00.000Z`;
  return {
    id: `${hhmm}-${over.source ?? "appointment"}-${mins}`,
    source: "appointment",
    start,
    end: new Date(Date.parse(start) + mins * 60_000).toISOString(),
    clientName: "Sam Reed",
    serviceName: "Skin Fade",
    serviceColor: null,
    price: 40,
    status: "upcoming",
    ...over,
  };
}

const block = (hhmm: string, mins: number, over: Partial<AgendaRow> = {}) =>
  at(hhmm, mins, { source: "block", status: "blocked", price: null, ...over });

describe("dayTotals — money", () => {
  it("counts upcoming and completed, and splits done from to-come", () => {
    const t = dayTotals([
      at("13:00", 30, { price: 40, status: "completed" }),
      at("14:00", 30, { price: 60, status: "upcoming" }),
    ]);
    expect(t.revenue).toBe(100);
    expect(t.doneRevenue).toBe(40);
    expect(t.toComeRevenue).toBe(60);
  });

  it("never counts canceled, and keeps pending out of the headline", () => {
    const t = dayTotals([
      at("13:00", 30, { price: 40, status: "canceled" }),
      at("14:00", 30, { price: 25, status: "pending" }),
    ]);
    expect(t.revenue).toBe(0);
    expect(t.pendingRevenue).toBe(25);
    // A cancellation is off the schedule; a request hasn't been accepted yet.
    expect(t.count).toBe(1);
  });

  it("earns nothing from a no-show but counts it", () => {
    const t = dayTotals([at("13:00", 30, { price: 40, status: "no_show" })]);
    expect(t.revenue).toBe(0);
    expect(t.noShowCount).toBe(1);
  });

  it("flags counted bookings with no price", () => {
    const t = dayTotals([at("13:00", 30, { price: null, status: "upcoming" })]);
    expect(t.unpricedCount).toBe(1);
    expect(t.revenue).toBe(0);
  });
});

describe("dayTotals — blocked minutes count the CHAIR, not the rows", () => {
  it("counts four identical blocks once", () => {
    // Drick's real day: Acuity held four identical 7:15-11:15 PM blocks and the
    // footer reported 16h off for a day with four hours taken. The chair can't
    // be blocked twice.
    const four = Array.from({ length: 4 }, (_, i) =>
      block("23:15", 240, { id: `dupe-${i}` }),
    );
    expect(dayTotals(four).blockedMin).toBe(240);
  });

  it("merges partially overlapping blocks", () => {
    const t = dayTotals([block("13:00", 120), block("14:00", 120)]);
    expect(t.blockedMin).toBe(180); // 1pm-4pm, not 4h
  });

  it("merges blocks that merely touch", () => {
    const t = dayTotals([block("13:00", 60), block("14:00", 60)]);
    expect(t.blockedMin).toBe(120);
  });

  it("still adds genuinely separate blocks", () => {
    const t = dayTotals([block("13:00", 60), block("17:00", 30)]);
    expect(t.blockedMin).toBe(90);
  });

  it("ignores a block with no end or a non-positive span", () => {
    const t = dayTotals([
      block("13:00", 60, { end: null }),
      block("15:00", 0),
      block("17:00", 30),
    ]);
    expect(t.blockedMin).toBe(30);
  });

  it("keeps blocks out of the booking count and the money", () => {
    const t = dayTotals([block("13:00", 60), at("15:00", 30, { price: 40 })]);
    expect(t.count).toBe(1);
    expect(t.revenue).toBe(40);
  });
});

describe("dayTotals — empty", () => {
  it("is all zeroes for a day with nothing on it", () => {
    const t = dayTotals([]);
    expect(t).toEqual({
      revenue: 0,
      doneRevenue: 0,
      toComeRevenue: 0,
      pendingRevenue: 0,
      unpricedCount: 0,
      noShowCount: 0,
      blockedMin: 0,
      count: 0,
    });
  });
});
