/**
 * Which way a horizontal drag on the day view meant to go, if it meant anything.
 *
 * The day planner is a tall, vertically-scrolling list that also contains
 * horizontally-scrolling strips (the category chips), so a swipe reader here has
 * to be conservative in two directions at once: too eager and the barber's
 * thumb-scroll flips the day out from under them mid-read; too strict and the
 * gesture never fires.
 *
 * Hence both a distance floor AND a dominance ratio. Distance alone would catch
 * the sideways drift of a fast vertical scroll; ratio alone would fire on a
 * 12px twitch during a tap.
 */
export type SwipeIntent = "prev" | "next" | null;

/**
 * A flick has to travel this far horizontally to count. Roughly a thumb's width
 * — comfortably past tap jitter, comfortably short of a full screen drag.
 */
export const SWIPE_MIN_PX = 56;

/**
 * ...and be this much more horizontal than vertical. 1.8 rather than a flat 1:1
 * because a real horizontal flick on a phone is nearly axis-pure, while a
 * scroll that happens to drift sideways is not.
 */
export const SWIPE_RATIO = 1.8;

export function swipeIntent(
  dx: number,
  dy: number,
  opts: { minPx?: number; ratio?: number } = {},
): SwipeIntent {
  const minPx = opts.minPx ?? SWIPE_MIN_PX;
  const ratio = opts.ratio ?? SWIPE_RATIO;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < minPx) return null;
  if (ax < ay * ratio) return null;
  // Dragging the content RIGHT pulls the previous day in from the left, which
  // is the direction every native calendar and photo viewer uses.
  return dx > 0 ? "prev" : "next";
}

/**
 * How close to the screen's side a touch can start and still be ours. iOS
 * (the app's web view allows back-swipe) and Android gesture navigation both
 * own a sideways drag that begins at the very edge: that is "go back", and
 * reading it as "previous day" too would do both at once.
 */
export const EDGE_GUTTER_PX = 24;

/**
 * Where a sideways drag already means something else, so it is never a day swipe:
 * typing (moving the caret, selecting text), a dialog, and anything inside
 * `[data-noswipe]` - the strips that do their own horizontal scrolling, where
 * hijacking the drag would make them unusable.
 */
const NOT_A_SWIPE =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], " +
  "[role='dialog'], [role='alertdialog'], [data-noswipe]";

/**
 * The full gate for the START of a day swipe.
 *
 * 🔴 THE TOUCH MUST START INSIDE THE CALENDAR ITSELF - in the DOM, not just in
 * the React tree. An appointment's sheet is a dialog PORTALED to <body>, and
 * React still bubbles its touch events up through the component that rendered
 * it - straight into the day view's swipe handler. A sideways drag inside an
 * open sheet changed the day, which unmounted the sheet and threw away the
 * edit in it. DOM containment is what tells the two apart.
 */
export function swipeStartAllowed(
  target: EventTarget | null,
  container: Element,
  clientX: number,
  viewportWidth: number,
): boolean {
  if (!(target instanceof Node) || !container.contains(target)) return false;
  if (clientX < EDGE_GUTTER_PX || clientX > viewportWidth - EDGE_GUTTER_PX) return false;
  const el = target instanceof Element ? target : target.parentElement;
  return el === null || el.closest(NOT_A_SWIPE) === null;
}
