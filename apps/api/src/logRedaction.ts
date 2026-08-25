/**
 * KEEP SECRETS OUT OF STDOUT.
 *
 * Several routes carry their own authenticator IN THE URL PATH - a waitlist
 * claim token, an appointment manage token, a client's rewards magic token, a
 * waitlist cancel token. Anything that reads stdout (a log drain, an alert
 * webhook, a support screenshot) therefore reads live credentials, and a log
 * channel has no expiry, no access control and no way to un-send.
 *
 * The previous redaction masked sensitive QUERY parameters and one hardcoded
 * path (`/webhooks/acuity/...`). That is the wrong axis: the identical secret
 * was redacted as `?token=` and printed in full as `/offer/<token>/claim`.
 *
 *  MASK BY ROUTE PATTERN, NOT BY INSPECTING THE VALUE.
 *
 * Guessing which strings "look like" tokens is a losing game - a cuid and a
 * random token are the same shape - and it fails open, which is the wrong
 * direction for a credential. Instead we ask Express which route matched and
 * blank the segments the ROUTE says are parameters.
 *
 * That makes masking the DEFAULT: a new `/:token` route is masked the day it
 * is written, because its parameter is not on the small allowlist of ids below
 * rather than because someone remembered to register it.
 */

/**
 * Parameters that are safe to keep, and worth keeping - these are the ids that
 * make a log line worth reading. Everything else is masked.
 *
 * 🔴 ONLY add a name here if it is a NON-SECRET identifier. If holding the
 * value grants access to anything, leave it off and it stays masked.
 */
export const SAFE_PARAMS = new Set([
  "id",
  "shopId",
  "staffId",
  "serviceId",
  "clientId",
  "entryId",
  "appointmentId",
  "slug",
  "groupId",
  "seriesId",
  "visitId",
  // Custom-domain lookup: a public hostname, and the most useful thing in the
  // line when a domain is misconfigured.
  "host",
  // Apple Wallet web-service parameters. These are IDENTIFIERS, not
  // credentials: that protocol authenticates with an Authorization header
  // (verifyPassAuth), which this serializer never emits at all. `serialNumber`
  // is literally the client id, and the device id is what makes a failed pass
  // registration diagnosable.
  "serialNumber",
  "passTypeIdentifier",
  "deviceLibraryIdentifier",
]);

export const REDACTED = "[redacted]";

/**
 * Query parameters whose VALUE is an authenticator.
 *
 *  - `token`   the team-invitation token (its own bearer: whoever holds it can
 *              accept the invitation as the invited address)
 *  - `code`    OAuth handoff codes and the mobile return code
 *  - `state`   binds a mobile handoff to one attempt; logging it weakens that
 */
const SENSITIVE_QUERY_PARAMS = ["token", "code", "state"];

/**
 * Path prefixes whose NEXT segment is a credential.
 *
 * This is only reached when Express could not tell us which route matched -
 * a body-parser failure, an oversized payload, or a 404 - because those abort
 * BEFORE routing and leave `req.route` undefined while the URL still holds the
 * secret. Measured, not assumed: a malformed JSON body posted to
 * `/api/book/manage/<token>/cancel` reaches the error handler with
 * `req.route === undefined`.
 *
 * `logRedaction.routeTable.test.ts` walks the real Express router table and
 * fails if any registered route has a non-safe parameter this list would miss,
 * so a new tokenized route cannot quietly bypass the fallback either.
 */
const SECRET_PATH_PREFIXES = [
  "/api/book/offer",
  "/api/book/manage",
  "/api/rewards",
  "/webhooks/acuity",
  // Waitlist cancel: the token is the LAST segment, handled below.
];

/** Prefixes whose FINAL segment is the credential (the rest is structural). */
const SECRET_TRAILING_PREFIXES = ["/waitlist/cancel"];

function splitPath(pathname: string): string[] {
  return pathname.split("/");
}

/**
 * Mask using the matched route pattern.
 *
 * `req.route.path` is the pattern WITHOUT the mount prefix (`/offer/:token/claim`
 * for a router mounted at `/api/book`), and by the time an app-level handler
 * runs Express has already reset `req.params` to `{}` and `req.baseUrl` to "".
 * So the pattern is aligned against the END of the path, which is exactly where
 * a mounted router's pattern applies.
 */
export function maskPathByRoute(pathname: string, routePath: string): string {
  const pathParts = splitPath(pathname);
  const patternParts = splitPath(routePath).filter((p, i) => !(i === 0 && p === ""));
  const offset = pathParts.length - patternParts.length;
  if (offset < 0) return pathname; // pattern longer than path: not our route

  const out = [...pathParts];
  for (let i = 0; i < patternParts.length; i += 1) {
    const seg = patternParts[i]!;
    if (!seg.startsWith(":")) continue;
    const name = seg.slice(1).replace(/[?*+()].*$/, "");
    if (SAFE_PARAMS.has(name)) continue;
    out[offset + i] = REDACTED;
  }
  return out.join("/");
}

/**
 * Mask without a route, for requests that died before routing.
 *
 * Deliberately blunt: it blanks the segment after a known credential-bearing
 * prefix rather than trying to recognise a credential.
 */
export function maskPathByPrefix(pathname: string): string {
  for (const prefix of SECRET_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length).split("/"); // ["", "<secret>", ...]
      if (rest.length > 1 && rest[1]) {
        rest[1] = REDACTED;
        return prefix + rest.join("/");
      }
    }
  }
  for (const prefix of SECRET_TRAILING_PREFIXES) {
    const at = pathname.indexOf(`${prefix}/`);
    if (at >= 0) {
      const head = pathname.slice(0, at + prefix.length);
      const rest = pathname.slice(at + prefix.length).split("/");
      if (rest.length > 1 && rest[1]) {
        rest[1] = REDACTED;
        return head + rest.join("/");
      }
    }
  }
  return pathname;
}

/** Mask `?token=`/`code`/`state` values wherever they appear. */
export function maskQuery(url: string): string {
  let out = url;
  for (const param of SENSITIVE_QUERY_PARAMS) {
    out = out.replace(new RegExp(`([?&]${param}=)[^&#]*`, "gi"), `$1${REDACTED}`);
  }
  return out;
}

/**
 * The one entry point. Give it whatever the caller has.
 *
 * Route pattern first (precise, keeps useful ids), prefix fallback second
 * (blunt, but a credential is never worth a readable log line). Both run: a
 * route-matched path can still fail the prefix check harmlessly, and a
 * mis-aligned pattern is then still caught.
 */
export function maskUrl(url: string, routePath?: string | null): string {
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const tail = hash >= 0 ? url.slice(hash) : "";
  const q = base.indexOf("?");
  let pathname = q >= 0 ? base.slice(0, q) : base;
  const query = q >= 0 ? base.slice(q) : "";

  if (routePath) pathname = maskPathByRoute(pathname, routePath);
  pathname = maskPathByPrefix(pathname);

  return maskQuery(pathname + query) + tail;
}
