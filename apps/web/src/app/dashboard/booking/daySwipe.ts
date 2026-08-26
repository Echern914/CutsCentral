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
 * Should a gesture starting on this element be read as a day swipe at all?
 *
 * Anything inside `[data-noswipe]` is opted out — those are the strips that do
 * their own horizontal scrolling, where a sideways drag already means something
 * and hijacking it would make them unusable.
 */
export function swipeAllowedFrom(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest("[data-noswipe]") === null;
}
