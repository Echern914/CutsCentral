import { createHash } from "node:crypto";

/**
 * THE ONE PLACE a Bearer credential is read off a request.
 *
 * 🔴 WHY THIS IS SHARED RATHER THAN CONVENIENT. Authentication and rate limiting
 * both parse the same header, and while they did it separately they disagreed:
 * `requireMcpAuth` captured `(.+)` and then TRIMMED the result, so
 * `"Bearer  tok"` (two spaces) authenticated as `tok` - while the limiter hashed
 * the raw header, so the same credential in that form landed in a DIFFERENT
 * bucket. One token, several fair-share buckets, and the 120/min per-connection
 * limit was as bypassable as the outer one had been: just re-space the header.
 *
 * Any future divergence between "what we authenticate as" and "what we count
 * as" is the same bug again, so there is exactly one function and both callers
 * use it.
 */

/**
 * Extract and canonicalise the token from an `Authorization` header.
 *
 * Returns null for anything that is not a well-formed Bearer credential - the
 * caller decides what to do with that (authentication refuses; the limiter
 * falls back to an address-scoped key so malformed credentials stay bounded by
 * the outer IP limit rather than escaping counting entirely).
 *
 * The scheme is matched case-insensitively because RFC 7235 §2.1 says the
 * scheme token is case-insensitive, and a client sending `bearer` is sending a
 * valid credential we would otherwise both reject AND count separately.
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^\s*Bearer\s+(\S.*)$/i.exec(header);
  if (!m) return null;
  const token = m[1]!.trim();
  return token.length > 0 ? token : null;
}

/**
 * The rate-limit key for a credential.
 *
 * 🔴 THE HASH IS LOAD-BEARING, NOT COSMETIC. This key is PERSISTED - PgRateStore
 * writes it to `rate_limit_counter` - so returning the raw header put live
 * bearer tokens in plaintext in a table that is meant to hold none, undoing the
 * reason `McpAccessToken` stores sha256 in the first place.
 *
 * 🔴 AND IT IS NOT AN OUTER BOUND. The value is chosen by the caller, so a new
 * credential is a new bucket: an attacker rotating it gets unlimited requests
 * from one host. This key is for FAIR-SHARING between authenticated callers and
 * nothing else; the bound comes from an IP-keyed limiter mounted in front.
 *
 * `fallback` is used when there is no well-formed credential to key on. It must
 * be address-scoped, so a flood of malformed headers from one host shares one
 * bucket instead of minting a fresh one per request.
 */
export function credentialKey(header: string | undefined, fallback: string): string {
  const token = bearerToken(header);
  if (token === null) return `ip:${fallback}`;
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32);
}
