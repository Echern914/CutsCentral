import { describe, expect, it } from "vitest";
import { SWIPE_MIN_PX, swipeIntent } from "./daySwipe";

/**
 * The day planner scrolls vertically and contains strips that scroll
 * horizontally, so this reader has to fail in BOTH directions safely: a
 * thumb-scroll must never flip the day out from under the barber mid-read, and
 * a real flick must not be swallowed.
 */
describe("swipeIntent", () => {
  it("reads a clean leftward flick as the next day", () => {
    expect(swipeIntent(-120, 4)).toBe("next");
  });

  it("reads a clean rightward flick as the previous day", () => {
    // Dragging content right pulls the previous day in from the left.
    expect(swipeIntent(120, -4)).toBe("prev");
  });

  it("ignores a tap wobble", () => {
    expect(swipeIntent(9, 3)).toBeNull();
  });

  it("ignores a vertical scroll that drifts sideways", () => {
    // The dangerous case: far enough horizontally to clear the distance floor,
    // but plainly a scroll. Without the ratio check this would flip the day.
    expect(swipeIntent(70, 300)).toBeNull();
  });

  it("ignores a diagonal drag that isn't clearly horizontal", () => {
    expect(swipeIntent(80, 60)).toBeNull();
  });

  it("requires the distance floor even when perfectly horizontal", () => {
    expect(swipeIntent(SWIPE_MIN_PX - 1, 0)).toBeNull();
    expect(swipeIntent(SWIPE_MIN_PX, 0)).toBe("prev");
  });

  it("treats a pure horizontal drag as horizontal (no divide-by-zero)", () => {
    expect(swipeIntent(-200, 0)).toBe("next");
  });

  it("honours overridden thresholds", () => {
    expect(swipeIntent(30, 0, { minPx: 20 })).toBe("prev");
    expect(swipeIntent(30, 0, { minPx: 40 })).toBeNull();
  });
});
