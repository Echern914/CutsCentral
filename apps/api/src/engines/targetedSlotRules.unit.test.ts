import { describe, expect, it } from "vitest";
import {
  effectiveSchedule,
  MAX_SLOTS_PER_WINDOW,
  occurrencesForTime,
} from "./targetedSlotRules.js";

/**
 * The window→occurrences expansion, in isolation. This is the seam every
 * materializer shares (create, roll-forward, edit-regenerate), so its edge
 * behaviour IS the product behaviour: what a "window" publishes.
 */
describe("occurrencesForTime", () => {
  it("a plain entry stays EXACTLY one slot, its own length (the original shape)", () => {
    expect(occurrencesForTime({ startMin: 21 * 60, durationMin: 60 }, 45)).toEqual([
      { startMin: 21 * 60, durationMin: 60 },
    ]);
    // No per-time duration: the rule's base fills in, as it always has.
    expect(occurrencesForTime({ startMin: 600 }, 45)).toEqual([
      { startMin: 600, durationMin: 45 },
    ]);
  });

  it("🔴 a window packs repeating slots while a WHOLE one fits", () => {
    // Drick's case: hours 9-10 PM, 30-min bookings -> 9:00 and 9:30, not one
    // hour-long slot and not a 9:45 that spills past his stated end.
    expect(
      occurrencesForTime({ startMin: 21 * 60, durationMin: 60, slotMin: 30 }, 45),
    ).toEqual([
      { startMin: 21 * 60, durationMin: 30 },
      { startMin: 21 * 60 + 30, durationMin: 30 },
    ]);
  });

  it("a partial tail slot is dropped, never truncated", () => {
    // 9:00-10:00 with 25-min slots: 9:00 and 9:25 fit; 9:50 would end 10:15.
    const out = occurrencesForTime(
      { startMin: 540, durationMin: 60, slotMin: 25 },
      45,
    );
    expect(out.map((o) => o.startMin)).toEqual([540, 565]);
    expect(out.every((o) => o.durationMin === 25)).toBe(true);
  });

  it("slot length == window length is one slot; longer than the window is none", () => {
    expect(
      occurrencesForTime({ startMin: 540, durationMin: 60, slotMin: 60 }, 45),
    ).toHaveLength(1);
    // The API refuses this shape, but the expander must still be safe under it.
    expect(
      occurrencesForTime({ startMin: 540, durationMin: 60, slotMin: 90 }, 45),
    ).toHaveLength(0);
  });

  it("is capped at MAX_SLOTS_PER_WINDOW, so a giant window cannot bloat a series", () => {
    const out = occurrencesForTime(
      { startMin: 0, durationMin: 600, slotMin: 5 },
      45,
    );
    expect(out).toHaveLength(MAX_SLOTS_PER_WINDOW);
  });
});

describe("effectiveSchedule carries slotMin through", () => {
  it("keeps a valid slotMin and drops a malformed one", () => {
    const sched = effectiveSchedule(
      {
        anchor: new Date("2026-09-07T21:00:00Z"),
        schedule: {
          "1": [
            { startMin: 1260, durationMin: 60, slotMin: 30 },
            { startMin: 600, durationMin: 60, slotMin: -5 },
          ],
        },
      },
      "UTC",
    );
    const times = sched["1"]!;
    expect(times.find((t) => t.startMin === 1260)?.slotMin).toBe(30);
    // Negative slotMin is dropped, leaving the entry a plain one-slot time.
    expect(times.find((t) => t.startMin === 600)?.slotMin).toBeUndefined();
  });
});
