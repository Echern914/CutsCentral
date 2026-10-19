import { describe, expect, it } from "vitest";
import type { DayView } from "./actions";
import { addOpening, changeCount, draftFromView, fillChair, rebaseDraft } from "./liveDay";

/**
 * The live view's draft rules (Drick: "make all cuts (20 min long) only on
 * that day and charge $65 all day" - and then change one opening's price, take
 * one off, add one). The placement rule is the server's own
 * (config/specialDay.ts); these pin how the draft uses it.
 */
const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function day(over: Partial<DayView["chairs"][number]> = {}, view: Partial<DayView> = {}): DayView {
  return {
    date: "2026-11-26",
    timezone: "UTC",
    bufferMin: 0,
    nowMin: null,
    name: null,
    serviceIds: [],
    basis: "b1",
    chairs: [
      {
        staffId: "st1",
        ruleIds: [],
        hours: [{ startMin: m("09:00"), endMin: m("17:00") }],
        openings: [],
        bookings: [],
        external: [],
        blocks: [],
        ...over,
      },
    ],
    ...view,
  };
}

describe("fill the day", () => {
  it("lays down every 20 minutes at $65, leaving out what sits on a booking or a block", () => {
    const v = day({
      bookings: [{ startMin: m("10:00"), endMin: m("10:30"), label: "Booked" }],
      blocks: [{ startMin: m("12:00"), endMin: m("13:00"), label: "Lunch" }],
    });
    const r = fillChair(v, v.chairs[0]!, [], { startMin: m("09:00"), endMin: m("17:00"), cutMin: 20, price: 65 });
    const starts = r.openings.map((o) => o.startMin);
    expect(r.openings).toHaveLength(24 - 2 - 3);
    expect(starts).not.toContain(m("10:00"));
    expect(starts).not.toContain(m("10:20"));
    expect(starts).not.toContain(m("12:00"));
    expect(r.openings.every((o) => o.price === 65 && o.durationMin === 20 && !o.id)).toBe(true);
    expect(r.skipped.map((s) => [s.startMin, s.reason])).toEqual([
      [m("10:00"), "booking"],
      [m("10:20"), "booking"],
      [m("12:00"), "blocked"],
      [m("12:20"), "blocked"],
      [m("12:40"), "blocked"],
    ]);
  });

  it("keeps booked openings, and re-uses a saved opening's row at the same time", () => {
    const v = day({
      ruleIds: ["r1"],
      openings: [
        { id: "a", startMin: m("09:00"), durationMin: 20, price: 65, booked: false },
        { id: "b", startMin: m("09:20"), durationMin: 20, price: 65, booked: true },
      ],
    });
    const r = fillChair(v, v.chairs[0]!, draftFromView(v).st1!, {
      startMin: m("09:00"),
      endMin: m("10:00"),
      cutMin: 20,
      price: 70,
    });
    expect(r.openings.map((o) => [o.startMin, o.id, o.price, o.booked])).toEqual([
      [m("09:00"), "a", 70, false],
      [m("09:20"), "b", 65, true],
      [m("09:40"), undefined, 70, false],
    ]);
    expect(r.skipped).toEqual([{ startMin: m("09:20"), reason: "opening" }]);
  });
});

describe("tap to add", () => {
  it("adds where it fits and says why where it doesn't", () => {
    const v = day({ bookings: [{ startMin: m("10:00"), endMin: m("10:30"), label: "Booked" }] });
    const ok = addOpening(v, v.chairs[0]!, [], { startMin: m("11:00"), durationMin: 20, price: 65 });
    expect(ok.ok).toBe(true);
    const clash = addOpening(v, v.chairs[0]!, [], { startMin: m("10:15"), durationMin: 20, price: 65 });
    expect(clash).toEqual({ ok: false, reason: "booking" });
    const late = addOpening(v, v.chairs[0]!, [], { startMin: m("23:50"), durationMin: 20, price: 65 });
    expect(late).toEqual({ ok: false, reason: "outside_day" });
    const past = addOpening(day({}, { nowMin: m("12:00") }), v.chairs[0]!, [], { startMin: m("11:00"), durationMin: 20, price: 65 });
    expect(past).toEqual({ ok: false, reason: "past" });
  });
});

describe("unsaved changes", () => {
  it("counts each added, removed and re-priced opening", () => {
    const v = day({
      openings: [
        { id: "a", startMin: m("09:00"), durationMin: 20, price: 65, booked: false },
        { id: "b", startMin: m("09:20"), durationMin: 20, price: 65, booked: false },
      ],
    });
    const d = draftFromView(v);
    expect(changeCount(v, d)).toBe(0);
    d.st1 = [
      { ...d.st1![0]!, price: 80 },
      { key: "n", startMin: m("11:00"), durationMin: 20, price: 65, booked: false },
    ];
    expect(changeCount(v, d)).toBe(3); // a re-priced, b removed, one added
  });
});

describe("the day changed under the barber", () => {
  it("keeps his changes that still fit, drops the ones a new booking sits on, and takes booked ones from the fresh day", () => {
    const before = day({
      openings: [{ id: "a", startMin: m("09:00"), durationMin: 20, price: 65, booked: false }],
    });
    const draft = draftFromView(before);
    draft.st1 = [
      { ...draft.st1![0]!, price: 90 },
      { key: "n1", startMin: m("11:00"), durationMin: 20, price: 65, booked: false },
      { key: "n2", startMin: m("14:00"), durationMin: 20, price: 65, booked: false },
    ];
    const fresh = day(
      {
        openings: [{ id: "a", startMin: m("09:00"), durationMin: 20, price: 65, booked: true }],
        bookings: [{ startMin: m("14:00"), endMin: m("14:30"), label: "Booked" }],
      },
      { basis: "b2" },
    );
    const r = rebaseDraft(fresh, draft);
    expect(r.draft.st1!.map((o) => [o.startMin, o.price, o.booked])).toEqual([
      [m("09:00"), 65, true],
      [m("11:00"), 65, false],
    ]);
    expect(r.dropped).toEqual([{ staffId: "st1", startMin: m("14:00") }]);
  });
});
