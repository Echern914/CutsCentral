import { afterEach, describe, expect, it } from "vitest";
import { EDGE_GUTTER_PX, SWIPE_MIN_PX, swipeIntent, swipeStartAllowed } from "./daySwipe";

/**
 * Where a day swipe may START. The calendar is a container; an appointment's
 * sheet is a dialog portaled to <body> - outside the container in the DOM, but
 * React still bubbles its touches up to the container's handler.
 */
describe("swipeStartAllowed", () => {
  const W = 390; // a phone
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function calendar(inner = "<div class='row'><span>2:00 PM Haircut</span></div>") {
    const el = document.createElement("div");
    el.innerHTML = inner;
    document.body.appendChild(el);
    return el;
  }

  it("a touch on the day's own content starts a swipe", () => {
    const c = calendar();
    expect(swipeStartAllowed(c.querySelector("span"), c, 200, W)).toBe(true);
  });

  it("🔴 a touch inside a sheet portaled to <body> never does - even though React bubbles it here", () => {
    const c = calendar();
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.innerHTML = "<input value='Edit me' /><p>Notes</p>";
    document.body.appendChild(sheet);
    expect(swipeStartAllowed(sheet.querySelector("p"), c, 200, W)).toBe(false);
    expect(swipeStartAllowed(sheet.querySelector("input"), c, 200, W)).toBe(false);
  });

  it("a portal WITHOUT a dialog role is still refused (containment, not the role, decides)", () => {
    const c = calendar();
    const popover = document.createElement("div");
    popover.innerHTML = "<button>Cancel</button>";
    document.body.appendChild(popover);
    expect(swipeStartAllowed(popover.querySelector("button"), c, 200, W)).toBe(false);
  });

  it("typing fields, dialogs and opted-out strips inside the calendar are refused", () => {
    const c = calendar(
      "<input id='amt' /><textarea id='note'></textarea><select id='sel'></select>" +
        "<div contenteditable='true' id='ce'>x</div>" +
        "<div role='alertdialog'><span id='ask'>Sure?</span></div>" +
        "<div data-noswipe><button id='chip'>Fades</button></div>",
    );
    for (const id of ["amt", "note", "sel", "ce", "ask", "chip"]) {
      expect(swipeStartAllowed(c.querySelector(`#${id}`), c, 200, W), id).toBe(false);
    }
  });

  it("a touch at the very edge belongs to the system's back gesture", () => {
    const c = calendar();
    const span = c.querySelector("span");
    expect(swipeStartAllowed(span, c, EDGE_GUTTER_PX - 1, W)).toBe(false);
    expect(swipeStartAllowed(span, c, W - EDGE_GUTTER_PX + 1, W)).toBe(false);
    expect(swipeStartAllowed(span, c, EDGE_GUTTER_PX, W)).toBe(true);
  });

  it("a text node target is judged by its element", () => {
    const c = calendar();
    const text = c.querySelector("span")!.firstChild!;
    expect(swipeStartAllowed(text, c, 200, W)).toBe(true);
  });

  it("no target is not a swipe", () => {
    expect(swipeStartAllowed(null, calendar(), 200, W)).toBe(false);
  });
});

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
