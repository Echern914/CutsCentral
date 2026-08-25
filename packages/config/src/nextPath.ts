/**
 * Where a post-authentication redirect is allowed to land.
 *
 * `?next=` is attacker-reachable: it arrives in a URL, survives a form POST as
 * a hidden field, and is then handed to `redirect()`. Two things go wrong if it
 * is trusted:
 *
 *  1. OPEN REDIRECT. "https://evil.example" or the protocol-relative
 *     "//evil.example" send a freshly-authenticated barber to a lookalike login
 *     page. Encoded forms ("%2f%2fevil.example", a backslash, "/%09/evil") slip
 *     past a naive `startsWith("/")` check because the BROWSER decodes and
 *     normalizes what our string comparison did not.
 *  2. UNINTENDED INTERNAL LANDINGS. Even same-origin, a redirect target chosen
 *     by whoever wrote the link is a capability. Signup only ever needs to
 *     resume a team invitation, so that is all it may do.
 *
 * So this is an ALLOWLIST, not a sanitizer: a candidate has to be a relative
 * path whose every decoding is still a relative path, and whose path portion is
 * one of the destinations the caller named. Anything else returns the caller's
 * fallback. There is no "clean it up and continue" branch - a value we don't
 * fully understand is discarded.
 *
 * Lives in @chairback/config so the web app and the API agree on one rule, and
 * so it is unit-testable (apps/web has no test runner).
 */

/**
 * Login may resume any gated surface the middleware bounced. These mirror
 * GATED_PREFIXES in apps/web/src/middleware.ts - that gate is what puts a
 * `next` on the URL in the first place - plus the invitation flow.
 */
export const LOGIN_NEXT_ALLOWLIST = [
  "/dashboard",
  "/onboarding",
  "/admin",
  "/team/join",
] as const;

/**
 * Signup may ONLY resume a team invitation.
 *
 * A brand-new account otherwise belongs in /onboarding (the shop-creation flow
 * a shop owner signs up for). An INVITED barber is the exception: they are
 * joining a shop that already exists, must not be walked through creating one,
 * and must not have to find the invitation email a second time.
 */
export const SIGNUP_NEXT_ALLOWLIST = ["/team/join"] as const;

/** Longest `next` we will even look at. */
const MAX_LENGTH = 512;

/** Control characters and whitespace a browser may strip before navigating. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f\\]/;

/** How many times to peel percent-encoding before deciding a value is opaque. */
const DECODE_ROUNDS = 3;

/**
 * A shape that is relative TO OUR ORIGIN. Rejects absolute URLs, scheme-ish
 * values, protocol-relative "//host", and the "/\host" form Chrome and Safari
 * both treat as protocol-relative.
 */
function isRelativeShape(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (FORBIDDEN_CHARS.test(value)) return false;
  if (value.includes("://")) return false;
  return true;
}

/**
 * The path portion (no query, no fragment), rejecting traversal.
 *
 * "/team/join/../../admin" is a same-origin path that a browser resolves
 * somewhere the allowlist never approved, so any "." or ".." segment is fatal
 * rather than normalized away.
 */
function pathOf(value: string): string | null {
  const path = value.replace(/[?#].*$/, "");
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  return path;
}

/** `path` is the allowlisted entry itself or something nested beneath it. */
function matches(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/**
 * Validate a `next` candidate against an allowlist, returning `fallback` for
 * anything that does not clearly and completely pass.
 *
 * The decode loop is the part worth keeping: we check the shape of the raw
 * value AND of each successive percent-decoding, because a browser decodes
 * before it navigates. "/%2f%2fevil.example" looks relative until one decode
 * turns it into "//evil.example". A value that fails to decode (a stray "%")
 * is treated as final rather than as an error - the raw form is what we
 * already validated.
 */
export function safeNextPath(
  raw: unknown,
  allow: readonly string[],
  fallback: string,
): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value || value.length > MAX_LENGTH) return fallback;

  let current = value;
  for (let round = 0; round <= DECODE_ROUNDS; round += 1) {
    if (!isRelativeShape(current)) return fallback;
    const path = pathOf(current);
    if (path === null) return fallback;
    if (round === 0 && !allow.some((entry) => matches(path, entry))) {
      return fallback;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break; // not decodable; the raw form is the only form
    }
    if (decoded === current) break;
    current = decoded;
  }
  return value;
}
