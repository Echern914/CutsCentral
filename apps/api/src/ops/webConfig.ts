import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import type { WebConfigReport } from "./preflight.js";

/**
 * Ask the WEB deployment what it can do.
 *
 * The operator preflight runs in this process and reads Railway's environment.
 * Analytics, the push public key and the Android fingerprint live in Vercel's,
 * and the NEXT_PUBLIC_* ones are inlined at ITS build time - unreachable from
 * here by any means other than asking. Without this, "which integrations are
 * live" can only ever answer for half the deployment, which is precisely how
 * four of them stayed dark for months behind a green report.
 *
 * Never throws and never blocks for long: a preflight that fails because a
 * status probe timed out is worse than one that says "could not check".
 */
export async function fetchWebConfig(): Promise<WebConfigReport | null> {
  const secret = process.env.WEB_PROXY_SECRET;
  const base = apiEnv().APP_BASE_URL?.replace(/\/$/, "");
  if (!secret || !base) return null;

  try {
    const res = await fetch(`${base}/api/ops/config`, {
      headers: { "x-cb-proxy-secret": secret },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      // 404 is what a secret MISMATCH looks like too - the web route hides
      // itself rather than admitting it exists to an unauthenticated caller.
      logger.warn({ status: res.status }, "ops: web config probe refused");
      return null;
    }
    const body = (await res.json()) as Partial<WebConfigReport>;
    return {
      posthog: Boolean(body.posthog),
      metaPixel: Boolean(body.metaPixel),
      pushPublicKey: Boolean(body.pushPublicKey),
      androidAppLinks: Boolean(body.androidAppLinks),
    };
  } catch (err) {
    logger.warn({ err }, "ops: web config probe failed");
    return null;
  }
}
