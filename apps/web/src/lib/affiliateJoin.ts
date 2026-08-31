/**
 * Pure helpers for the /join referral entry point.
 *
 * Everything here treats the query string as hostile: it arrives from whatever
 * someone put in a link they shared, so values are allowlisted by key, bounded
 * in length, and never reflected back into the page.
 */

/**
 * Marketing parameters carried through to signup so a campaign keeps its
 * shape. They are for reporting only - nothing in attribution or qualification
 * ever reads them, so a forged utm_source buys an attacker nothing.
 */
const SAFE_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

/** Longest value we will carry. Matches the legacy attribution cap. */
const MAX_VALUE_LENGTH = 200;

/**
 * Keep only allowlisted marketing parameters, bounded and de-duplicated.
 * Anything else - including a second `ref`, a `next`, or an open-redirect
 * attempt - is dropped rather than sanitized into something.
 */
export function safeCampaignParams(input: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of SAFE_QUERY_KEYS) {
    const value = input.get(key);
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) continue;
    out.set(key, trimmed);
  }
  return out;
}

/**
 * Where a visitor goes after their claim is parked: always our own signup
 * path, never a destination taken from the URL. Returned as a root-relative
 * path so it cannot be pointed at another origin.
 */
export function signupTargetPath(input: URLSearchParams): string {
  const params = safeCampaignParams(input);
  const query = params.toString();
  return query ? `/signup?${query}` : "/signup";
}
