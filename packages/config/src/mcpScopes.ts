/**
 * What an assistant can be granted.
 *
 * 🔴 EVERY SCOPE IN THIS RELEASE IS READ-ONLY, and that is enforced in three
 * independent places rather than trusted once:
 *
 *   1. `WRITE_SCOPES` is empty, so no write scope has a name to ask for;
 *   2. the authorize endpoint refuses any scope not in `READ_SCOPES`;
 *   3. `McpConnection.accessLevel` can only be minted as READ_ONLY here.
 *
 * The MANAGEMENT level exists in the database type so the column never has to
 * change, but nothing in this PR can produce it. The write-proposal PR adds the
 * confirmation flow FIRST and only then the scopes that need it.
 *
 * Scope names are `chairback:<area>:read`. The area matches the tool families
 * the read-only tools PR will add, so a human reading a consent screen sees the
 * same words as the tool list.
 */

export const READ_SCOPES = [
  /** Product help, feature lookup and navigation targets. No shop data at all. */
  "chairback:help:read",
  /** Setup progress and what is currently blocking the shop. */
  "chairback:readiness:read",
  /** Appointments, open times, blocked time, booking requests. */
  "chairback:calendar:read",
  /** Daily/weekly summaries, revenue progress, utilisation. */
  "chairback:business:read",
  /** Client summaries and history. Bounded and PII-minimised at the tool. */
  "chairback:clients:read",
  /** Waitlist entries and matches. */
  "chairback:waitlist:read",
  /** Acuity/Square connection and sync health. */
  "chairback:integrations:read",
] as const;

export type ReadScope = (typeof READ_SCOPES)[number];

/**
 * Deliberately empty. See the note above - this is a load-bearing empty array,
 * not a placeholder, and the test suite asserts it stays empty until the
 * proposal flow exists.
 */
export const WRITE_SCOPES: readonly string[] = [];

export const ALL_SCOPES: readonly string[] = [...READ_SCOPES, ...WRITE_SCOPES];

/**
 * The scopes granted when a client asks for none.
 *
 * Only help and readiness: the two that carry no customer data. A client that
 * wants the calendar has to say so, and the human has to see it on the consent
 * screen. Defaulting to everything would make the consent screen a formality.
 */
export const DEFAULT_SCOPES: readonly string[] = [
  "chairback:help:read",
  "chairback:readiness:read",
];

/** Human-facing description, shown on the consent screen next to each scope. */
export const SCOPE_LABELS: Record<string, string> = {
  "chairback:help:read": "Read ChairBack help and find features",
  "chairback:readiness:read": "See your setup progress and what needs attention",
  "chairback:calendar:read": "See your appointments, openings and blocked time",
  "chairback:business:read": "See your revenue, utilisation and daily summaries",
  "chairback:clients:read": "See client summaries and visit history",
  "chairback:waitlist:read": "See who is on your waitlist",
  "chairback:integrations:read": "See your Acuity and Square connection health",
};

/**
 * Parse an OAuth `scope` parameter (RFC 6749: space-delimited).
 *
 * 🔴 UNKNOWN SCOPES ARE AN ERROR, not something to ignore. Silently dropping an
 * unrecognised scope would let a client believe it holds a capability it does
 * not, and would let a future typo'd scope name fail open rather than loudly.
 */
export function parseScopes(
  raw: string | undefined,
): { ok: true; scopes: string[] } | { ok: false; unknown: string[] } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, scopes: [...DEFAULT_SCOPES] };
  }
  const asked = raw.trim().split(/\s+/);
  const unknown = asked.filter((s) => !ALL_SCOPES.includes(s));
  if (unknown.length > 0) return { ok: false, unknown };
  // De-duplicate, and keep the canonical order rather than the client's, so the
  // consent screen and the stored grant always read the same way.
  return { ok: true, scopes: ALL_SCOPES.filter((s) => asked.includes(s)) };
}

/** True when every scope named is one this release can actually serve. */
export function isReadOnly(scopes: readonly string[]): boolean {
  return scopes.every((s) => (READ_SCOPES as readonly string[]).includes(s));
}
