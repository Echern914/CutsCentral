import { afterEach, describe, expect, it } from "vitest";
import type { DayView } from "./actions";
import { addOpening, clockRange, closedDay, dayLabel, fillChair, spanLabel, summarizeFill } from "./liveDay";

/**
 * What the live view SAYS about a day (Drick, on Thanksgiving: a day he had
 * blocked off showed "Blocked · 12:00 AM–12:00 AM", claimed clients could book
 * his normal hours, and a fill listed every one of 30 skipped times in one
 * paragraph). These pin the words, the date and the override rule.
 */
const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function day(over: Partial<DayView["chairs"][number]> = {}): DayView {
  return {
    date: "2026-11-26",
    timezone: "America/New_York",
    bufferMin: 0,
    nowMin: null,
    name: null,
    serviceIds: [],
    basis: "b1",
    chairs: [
      {
        staffId: "st1",
        ruleIds: [],
        hours: [{ startMin: m("10:00"), endMin: m("20:00") }],
        openings: [],
        bookings: [],
        external: [],
        blocks: [],
        ...over,
      },
    ],
  };
}

describe("the fill result is one short line", () => {
  it("merges contiguous skipped times into ranges and keeps separate reasons apart", () => {
    const skipped = [
      ...["10:00", "10:20", "10:40", "11:00"].map((t) => ({ startMin: m(t), reason: "blocked" as const })),
      ...["14:20", "14:40", "15:00", "15:20"].map((t) => ({ startMin: m(t), reason: "booking" as const })),
      ...["15:40", "16:00"].map((t) => ({ startMin: m(t), reason: "blocked" as const })),
    ];
    expect(summarizeFill({ made: 0, price: 60, cutMin: 20, bufferMin: 0, skipped })).toBe(
      "No openings added. Skipped 10:00–11:20 AM and 3:40–4:20 PM (blocked off); 2:20–3:40 PM (bookings).",
    );
  });

  it("names what was added and its price; nothing skipped says nothing more", () => {
    expect(summarizeFill({ made: 22, price: 60, cutMin: 20, bufferMin: 0, skipped: [] })).toBe("Added 22 openings at $60.");
    expect(
      summarizeFill({
        made: 1,
        price: 62.5,
        cutMin: 20,
        bufferMin: 0,
        skipped: [{ startMin: m("14:20"), reason: "booking" }],
      }),
    ).toBe("Added 1 opening at $62.50. Skipped 2:20–2:40 PM (bookings).");
  });

  it("a turnover between openings still reads as one range", () => {
    // 20-min cuts + 10-min turnover start every 30 minutes.
    const skipped = ["12:00", "12:30", "13:00"].map((t) => ({ startMin: m(t), reason: "blocked" as const }));
    expect(summarizeFill({ made: 5, price: 65, cutMin: 20, bufferMin: 10, skipped })).toBe(
      "Added 5 openings at $65. Skipped 12:00–1:20 PM (blocked off).",
    );
  });
});

describe("times and dates", () => {
  it("a whole-day block is 'all day', never 12:00 AM–12:00 AM", () => {
    expect(spanLabel(0, 1440)).toBe("all day");
    expect(spanLabel(m("12:00"), m("13:00"))).toBe("12:00–1:00 PM");
    expect(clockRange(m("10:00"), m("14:20"))).toBe("10:00 AM–2:20 PM");
    expect(clockRange(m("23:00"), 1440)).toBe("11:00 PM–midnight");
  });

  const realTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = realTz;
  });

  it.each(["America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Kiritimati", "UTC"])(
    "Thanksgiving 2026 reads Thu, Nov 26 in a browser on %s",
    (tz) => {
      process.env.TZ = tz;
      expect(dayLabel("2026-11-26")).toBe("Thu, Nov 26");
    },
  );
});

describe("is the day already shut?", () => {
  it("blocked all day, even with bookings left on it from before the block", () => {
    expect(
      closedDay({
        hours: [{ startMin: m("10:00"), endMin: m("20:00") }],
        blocks: [{ startMin: 0, endMin: 1440, label: "Blocked", ownBlockId: "b1" }],
      }),
    ).toBe("blocked");
  });

  it("blocks that together cover his hours shut it; a lunch break does not", () => {
    const hours = [{ startMin: m("10:00"), endMin: m("20:00") }];
    expect(
      closedDay({
        hours,
        blocks: [
          { startMin: m("09:00"), endMin: m("15:00"), label: "Blocked" },
          { startMin: m("15:00"), endMin: m("21:00"), label: "Blocked" },
        ],
      }),
    ).toBe("blocked");
    expect(closedDay({ hours, blocks: [{ startMin: m("12:00"), endMin: m("13:00"), label: "Lunch" }] })).toBeNull();
    expect(closedDay({ hours: [], blocks: [] })).toBe("off");
  });
});

describe("opening special times over his own block-off", () => {
  const blockedDay = day({
    bookings: [{ startMin: m("14:20"), endMin: m("15:40"), label: "Booked" }],
    blocks: [
      { startMin: 0, endMin: 1440, label: "Blocked", ownBlockId: "own" },
      { startMin: m("18:00"), endMin: m("19:00"), label: "Blocked in Acuity" },
    ],
  });
  const chair = blockedDay.chairs[0]!;
  const spec = { startMin: m("10:00"), endMin: m("20:00"), cutMin: 20, price: 60 };

  it("refuses by default - the block-off wins until he chooses otherwise", () => {
    const r = fillChair(blockedDay, chair, [], spec);
    expect(r.openings).toHaveLength(0);
  });

  it("when he chooses it, only his own block-off gives way - never a booking or Acuity time", () => {
    const r = fillChair(blockedDay, chair, [], spec, { overOwnBlocks: true });
    const starts = r.openings.map((o) => o.startMin);
    expect(starts).toContain(m("10:00"));
    expect(starts.some((s) => s >= m("14:20") && s < m("15:40"))).toBe(false);
    expect(starts.some((s) => s >= m("18:00") && s < m("19:00"))).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toEqual(["booking", "booking", "booking", "booking", "blocked", "blocked", "blocked"]);
    expect(addOpening(blockedDay, chair, [], { startMin: m("09:05"), durationMin: 20, price: 60 }, { overOwnBlocks: true }).ok).toBe(true);
    expect(addOpening(blockedDay, chair, [], { startMin: m("09:05"), durationMin: 20, price: 60 }).ok).toBe(false);
  });
});
