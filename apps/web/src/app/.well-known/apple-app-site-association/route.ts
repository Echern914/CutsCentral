import { NextResponse } from "next/server";
import { MOBILE_APP } from "@chairback/config/constants";

/**
 * Apple App Site Association (AASA). iOS fetches this to verify that
 * https://getchairback.com links may open the ChairBack app
 * (associatedDomains: applinks:getchairback.com in the app config). Without it,
 * tapping any of these opens Safari instead of the app.
 *
 * Served as a route handler (not a static file) to guarantee the exact
 * application/json content-type, a 200, and NO redirect - Apple rejects the
 * AASA on any redirect or wrong content-type. appID is <TeamID>.<bundleId>.
 *
 * THREE PATHS, one per thing the app can meaningfully take over:
 *
 *  - /r/*                     the customer magic link. The original, and the
 *                             reason this file exists. Do not narrow it.
 *  - /team/join*              an invitation. Tapping it in Mail should land in
 *                             the app when the app is installed, rather than
 *                             stranding the barber in a browser.
 *  - /auth/mobile/callback*   the return leg of "Join your shop". This one is
 *                             belt-and-braces: inside the system authentication
 *                             browser the session closes on a custom-scheme
 *                             navigation, not a universal link, so this claim
 *                             is what catches the case where the flow finished
 *                             in ORDINARY Safari (the sheet was dismissed, or
 *                             the link was opened from an email on the phone).
 *
 * Trailing "*" on the last two also matches the query string, which both carry.
 *
 * iOS caches this file. A changed path list reaches an INSTALLED app only on
 * reinstall or when the CDN-cached copy Apple holds refreshes - so ship the
 * file before the build that depends on it, and never assume a fresh path is
 * live for existing installs.
 */
const TEAM_ID = "ZLP9T7HSYJ";

export async function GET(): Promise<NextResponse> {
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${TEAM_ID}.${MOBILE_APP.iosBundleId}`,
          paths: [
            "/r/*",
            `${MOBILE_APP.teamJoinPath}*`,
            `${MOBILE_APP.authCallbackPath}*`,
          ],
        },
      ],
    },
  };
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
