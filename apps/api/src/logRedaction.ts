/**
 * WHAT A REQUEST URL IS ALLOWED TO SAY IN A LOG.
 *
 * Its own module rather than a corner of app.ts, because there is more than one
 * place that logs a URL - the pino-http request line, the 500 handler, the
 * rate-limiter warning, the admin IP block - and the middleware among them
 * cannot import app.ts without a cycle. One function, every sink.
 */

/**
 * Query parameters whose VALUE is an authenticator. A request URL is logged on
 * every hit, shipped to whatever aggregates our logs, and kept far longer than
 * the credential lives - so these are masked before any of that.
 *
 *  - `token`   the team-invitation token (its own bearer: whoever holds it can
 *              accept the invitation as the invited address)
 *  - `code`    OAuth handoff codes and the mobile return code
 *  - `state`   binds a mobile handoff to one attempt; logging it weakens that
 */
const SENSITIVE_QUERY_PARAMS = ["token", "code", "state"];

/**
 * 🔴 ROUTES WHERE THE PATH SEGMENT *IS* THE CREDENTIAL.
 *
 * A query string at least looks like something to be careful with. A path
 * segment reads like an id, and these are not ids - each one is a bearer
 * secret that is enough, on its own, to act as somebody:
 *
 *  - `/webhooks/acuity/:secret`      the URL is that route's only authenticator
 *  - `/api/rewards/:magicToken`      Client.magicToken. GLOBAL and PERMANENT -
 *                                    it resolves without a shop, never expires,
 *                                    and is the whole of a customer's rewards
 *                                    session, including opt-out and delete
 *  - `/api/book/offer/:token`        claim someone's held waitlist slot
 *  - `/api/book/manage/:token`       cancel or reschedule someone's booking
 *  - `/api/page/waitlist/cancel/:token`  cancel someone's place in the queue
 *
 * Every one of those is stored HASHED (or resolved by lookup) precisely so a
 * leaked database backup cannot be replayed. Logging the raw value undoes that
 * for anyone who can read the log stream - and unlike a database, a log is
 * routinely forwarded somewhere with a longer memory and looser access than the
 * thing it describes. There is no expiry on a chat message.
 *
 * 🔑 The prefixes are spelled out in full ON PURPOSE. `/rewards/` alone would
 * also swallow `/api/loyalty/rewards/:id`, which is an ordinary row id a
 * developer needs to see, and over-redaction is how a log stops being worth
 * reading.
 */
const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(\/webhooks\/acuity\/)[^/?#]+/,
  /(\/api\/rewards\/)[^/?#]+/,
  /(\/api\/book\/offer\/)[^/?#]+/,
  /(\/api\/book\/manage\/)[^/?#]+/,
  /(\/api\/page\/waitlist\/cancel\/)[^/?#]+/,
];

/**
 * Strip every credential out of a request URL - path secrets above, query
 * secrets below - leaving the route shape, which is the part worth logging.
 *
 * ONE function, because there is more than one sink. The pino-http request line
 * and the 500 handler both log a URL, they are both forwarded onward, and a
 * redaction that covered one of them would read as solved while the other kept
 * publishing tokens.
 */
export function redactUrl(url: string): string {
  let out = url;
  for (const pattern of SECRET_PATH_PATTERNS) out = out.replace(pattern, "$1[redacted]");
  for (const param of SENSITIVE_QUERY_PARAMS) {
    out = out.replace(new RegExp(`([?&]${param}=)[^&#]*`, "gi"), "$1[redacted]");
  }
  return out;
}

/**
 * The URL as the CLIENT asked for it.
 *
 * Express REWRITES `req.url` while a mounted router is handling the request,
 * stripping the mount prefix - and every pattern above names its prefix in
 * full, so a stripped URL would match none of them and pass the token straight
 * through. In practice that does not bite: `req.url` is restored by the time
 * pino-http serializes (on response finish) and by the time an app-level error
 * handler runs, and a test pins the mounted case end to end.
 *
 * 🔑 So this is belt and braces, not a fix for an observed bug. `originalUrl`
 * is the one field Express documents as untouched, and the cost of depending
 * on that instead of on when a handler happens to run is nothing.
 */
export function requestUrl(req: { originalUrl?: string; url?: string }): string {
  return req.originalUrl ?? req.url ?? "";
}

/**
 * pino-http req serializer. Logs the method and a redacted URL, and nothing
 * else - no headers, no body, no query values that authenticate anybody.
 */
export function redactedReqSerializer(req: {
  method?: string;
  originalUrl?: string;
  url?: string;
  [k: string]: unknown;
}) {
  return { method: req.method, url: redactUrl(requestUrl(req)) };
}
