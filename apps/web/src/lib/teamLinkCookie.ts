import { cookies } from "next/headers";

/**
 * Remembers which team someone was joining while they set up their business.
 *
 * A barber new to ChairBack opens a shop's team link, has no business yet, and
 * is sent through /onboarding to create one. This cookie carries the team so
 * the request is sent the moment the business exists (createShopAction). It is
 * forgotten as soon as the request is in - and on sign-out - so on a shared
 * browser it can never ask on the NEXT person's behalf. It only ever becomes a
 * join request or a link back to /team/link/<key>, and the key is checked
 * against the shape a shop id can have first. Server-side use only.
 */
export const TEAM_LINK_COOKIE = "cb_team_link";

/** A shop id (a cuid) - nothing that could escape the path it's placed in. */
export function teamKeyOk(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

/** Forget the team being joined: its request is in, or the person signed out. */
export function clearTeamLinkCookie(): void {
  cookies().delete(TEAM_LINK_COOKIE);
}
