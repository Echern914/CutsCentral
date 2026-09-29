/**
 * Where the app's session handoff (/app-auth) lands.
 *
 * `?next=` carries the page a tapped barber notification links to - one
 * appointment, usually ("when I tap a notification it should take me directly
 * to that day and time's appointment"). Anything that is not a same-origin
 * /dashboard path lands on /dashboard, so the handoff can never be an open
 * redirect: no scheme, no host, no "//" (a browser reads that as a host).
 */
export function appAuthLanding(next: string | null | undefined): string {
  if (!next || !/^\/dashboard(?:[/?]|$)/.test(next)) return "/dashboard";
  if (next.includes("//") || next.includes("\\")) return "/dashboard";
  return next;
}
