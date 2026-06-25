import { NextResponse } from "next/server";

/**
 * Apple App Site Association (AASA). iOS fetches this to verify that
 * https://getchairback.com/r/<token> universal links may open the ChairBack
 * Rewards app (associatedDomains: applinks:getchairback.com in the app config).
 * Without it, tapping a magic link opens Safari instead of the app.
 *
 * Served as a route handler (not a static file) to guarantee the exact
 * application/json content-type, a 200, and NO redirect - Apple rejects the AASA
 * on any redirect or wrong content-type. Path /r/* matches the magic-link route;
 * appID is <TeamID>.<bundleId>.
 */
const TEAM_ID = "ZLP9T7HSYJ";
const BUNDLE_ID = "com.getchairback.rewards";

export async function GET(): Promise<NextResponse> {
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${TEAM_ID}.${BUNDLE_ID}`,
          paths: ["/r/*"],
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
