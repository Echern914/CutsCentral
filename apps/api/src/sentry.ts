import * as Sentry from "@sentry/node";
import { apiEnv } from "@chairback/config";
import { redactUrl } from "./logRedaction.js";

/**
 * Error monitoring seam. With SENTRY_DSN unset (local dev, tests) this whole
 * module is a no-op; set the DSN on Railway and 500s/crashes start reporting.
 * Deliberately minimal: no tracing/profiling, just exceptions.
 *
 * 🔴 SENTRY IS A SINK, EXACTLY LIKE STDOUT. The SDK's request-data
 * instrumentation attaches the incoming request to an event on its own - the
 * URL, the query string, sometimes the body - which is precisely the material
 * #297/#298 spent two PRs keeping out of the logs. Twenty-one routes carry a
 * live bearer credential in the PATH, and a login's body carries a password.
 * So every event passes through scrubSentryEvent before it leaves the
 * process, reusing the SAME redaction the log stream uses (logRedaction.ts) -
 * two sinks, one rule, no second list to forget.
 */

/** Request headers that authenticate somebody. Compared lowercased. */
const SECRET_EVENT_HEADERS = ["cookie", "authorization", "set-cookie"];

/**
 * Strip credentials from an outgoing Sentry event, in place, and return it.
 *
 * Exported for tests; wired as `beforeSend`. Everything here is defensive
 * against what the SDK *can* attach, not what today's capture sites pass -
 * captureError's own `extra` is already redacted at the call sites, but the
 * auto-attached request context never went through them.
 */
export function scrubSentryEvent<
  T extends {
    request?: {
      url?: string;
      query_string?: unknown;
      headers?: Record<string, string>;
      cookies?: unknown;
      data?: unknown;
    };
    breadcrumbs?: { data?: Record<string, unknown> }[];
  },
>(event: T): T {
  const req = event.request;
  if (req) {
    // The URL: same patterns as the log stream (path secrets + query secrets).
    if (typeof req.url === "string") req.url = redactUrl(req.url);
    // The query string travels as its own field too. The string form is
    // masked through the same function; any other shape is dropped rather
    // than guessed at.
    if (typeof req.query_string === "string") {
      req.query_string = redactUrl(`?${req.query_string}`).slice(1);
    } else if (req.query_string !== undefined) {
      delete req.query_string;
    }
    // 🔴 The BODY is deleted, not masked. A login body is a password; there
    // is no fraction of a request body worth arguing about in a scrubber.
    delete req.data;
    delete req.cookies;
    if (req.headers) {
      for (const name of Object.keys(req.headers)) {
        if (SECRET_EVENT_HEADERS.includes(name.toLowerCase())) {
          delete req.headers[name];
        }
      }
    }
  }
  // Breadcrumbs record outgoing HTTP calls; their URLs get the same treatment.
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.data && typeof crumb.data.url === "string") {
      crumb.data.url = redactUrl(crumb.data.url);
    }
  }
  return event;
}

let enabled = false;

export function initSentry(): void {
  const env = apiEnv();
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
    // The SDK default, pinned on purpose: never infer IPs or attach PII the
    // scrubber below would only have to strip again.
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
  });
  enabled = true;
}

export function captureError(err: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, extra ? { extra } : undefined);
}
