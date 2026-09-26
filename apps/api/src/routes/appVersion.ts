import { Router } from "express";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";

/**
 * GET /api/app-version - the oldest app build still allowed to run.
 *
 * The iOS app asks on launch and whenever it comes back to the foreground; a
 * build older than `iosMinimumBuild` covers itself with "Update ChairBack" and
 * a button to the App Store. `null` means nobody is asked to update.
 *
 * 🔴 ONLY BUILDS THAT CONTAIN THE CHECK CAN BE STOPPED. Build 49 was the first;
 * builds 47 and 48 never ask, whatever this says.
 *
 * 🔴 A MINIMUM ABOVE THE BUILD THAT IS LIVE IN THE APP STORE LOCKS EVERYONE
 * OUT: they are told to update and the App Store has nothing newer to give
 * them. Raise IOS_MINIMUM_BUILD only after that build is released. Lowering it
 * again unblocks each phone the next time the app comes to the foreground.
 *
 * Public, no session, no database: it answers the same constant to everyone
 * and names nothing but a build number. No rate limiter for the same reason -
 * a crowd of customers on one shop's wifi must never be 429'd into a check
 * that has no work behind it (the app treats any failure as "carry on").
 */

/**
 * IOS_MINIMUM_BUILD as a number, or null for "off".
 *
 * Unset, empty and "0" are off. Anything that is not a whole number is ALSO
 * off, and reported: a mistyped rollout knob must not be able to take the API
 * down (the 2026-09-11 lesson), and "nobody is forced to update" is the
 * harmless direction to fail in.
 */
export function minimumBuildFrom(raw: string | undefined): {
  build: number | null;
  invalid: boolean;
} {
  const value = (raw ?? "").trim();
  if (value === "") return { build: null, invalid: false };
  if (!/^\d+$/.test(value)) return { build: null, invalid: true };
  const build = Number(value);
  if (!Number.isSafeInteger(build)) return { build: null, invalid: true };
  return { build: build > 0 ? build : null, invalid: false };
}

const iosMinimum = minimumBuildFrom(apiEnv().IOS_MINIMUM_BUILD);

/**
 * Say a mistyped IOS_MINIMUM_BUILD out loud: an error line in the deploy log
 * and a Sentry entry. Called from index.ts AFTER initSentry - this module is
 * imported before Sentry starts, so reporting at import would be dropped.
 */
export function reportAppVersionConfig(): void {
  if (!iosMinimum.invalid) return;
  const message =
    "IOS_MINIMUM_BUILD is not a whole number; the app update check is OFF until it is fixed";
  logger.error({ reason: "ios_minimum_build_invalid" }, message);
  captureError(new Error(message), { reason: "ios_minimum_build_invalid" });
}

export const appVersionRouter: Router = Router();

appVersionRouter.get("/", (_req, res) => {
  // Never cached anywhere: lowering the number must reach a blocked phone on
  // its next check, not after some cache's idea of fresh.
  res.set("Cache-Control", "no-store");
  res.json({ iosMinimumBuild: iosMinimum.build });
});
