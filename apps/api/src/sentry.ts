import * as Sentry from "@sentry/node";
import { apiEnv } from "@chairback/config";

/**
 * Error monitoring seam. With SENTRY_DSN unset (local dev, tests) this whole
 * module is a no-op; set the DSN on Railway and 500s/crashes start reporting.
 * Deliberately minimal: no tracing/profiling, just exceptions.
 */
let enabled = false;

export function initSentry(): void {
  const env = apiEnv();
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function captureError(err: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, extra ? { extra } : undefined);
}
