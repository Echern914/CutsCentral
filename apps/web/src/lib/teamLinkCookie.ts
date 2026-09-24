/**
 * Remembers which team someone was joining while they set up their business.
 *
 * A barber new to ChairBack opens a shop's team link, has no business yet, and
 * is sent through /onboarding to create one. This cookie carries the team so
 * onboarding's last screen can offer "Finish joining" instead of leaving them
 * to find the link again. It only ever becomes a link back to /team/link/<key>,
 * and the key is checked against the shape a slug or id can have first.
 */
export const TEAM_LINK_COOKIE = "cb_team_link";

/** A slug or a cuid - nothing that could escape the path it's placed in. */
export function teamKeyOk(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
}
