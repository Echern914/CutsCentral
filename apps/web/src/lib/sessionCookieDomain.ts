/**
 * Cookie Domain widening for the session.
 *
 * The session cookie normally lives on the web origin only - every dashboard
 * call is server-side and forwards it manually. The ONE flow where the BROWSER
 * must hit the API authenticated is the Acuity OAuth start (a top-level
 * navigation to api.<apex>/api/acuity/oauth/start). For the cookie to ride
 * along, it must be scoped to the shared parent domain (.getchairback.com),
 * which only exists now that web and API live on the same apex.
 *
 * Returns ".<apex>" when the request is on the product domain, undefined
 * everywhere else (localhost dev, vercel.app previews/aliases) so those keep
 * host-only cookies - a foreign Domain attribute would be rejected anyway.
 */
const APP_HOST = (() => {
  try {
    return new URL(process.env.APP_BASE_URL ?? "").hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
})();

export function sessionCookieDomain(requestHost: string | null): string | undefined {
  if (!APP_HOST || APP_HOST === "localhost") return undefined;
  const hostname = (requestHost ?? "").split(":")[0]!.toLowerCase();
  if (hostname === APP_HOST || hostname.endsWith(`.${APP_HOST}`)) {
    return `.${APP_HOST}`;
  }
  return undefined;
}
