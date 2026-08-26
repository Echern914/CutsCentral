/**
 * Bring a step the customer just unlocked into view.
 *
 * The booking page is ONE long scrolling column: picking a day fills in the
 * services below it, opening a service card unfolds its times, picking a time
 * mounts the details form below that. On a phone all of that happens
 * off-screen — the tap registers, the page doesn't move, and the next thing to
 * do is somewhere under your thumb. Customers read that as "nothing happened"
 * and tap again.
 *
 * `block: "start"` rather than "center": these are tall steps, and centring a
 * service list puts its own heading above the fold and hides the first row.
 *
 * Reduced motion gets an instant jump rather than no jump — the customer still
 * needs to end up at the new step; they just don't want to be flown there. Same
 * handling as the demo tour, which is the only other explicit scroll in the app.
 */
export function revealElement(el: HTMLElement | null): void {
  if (!el || typeof window === "undefined") return;
  el.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
}

/**
 * Read at call time, never cached: a customer can turn the OS setting on
 * mid-session, and a value captured at module load would keep animating.
 * Defensive about `matchMedia` itself — jsdom and older in-app webviews have
 * been known not to provide it, and a missing accessibility API must degrade to
 * "animate", never to a crash that takes the booking page down.
 */
function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
