import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { MOBILE_APP } from "@chairback/config/constants";

/**
 * The file iOS fetches to decide whether a getchairback.com link may open the
 * app. Every assertion here is about something Apple rejects silently, or about
 * a path whose absence costs a real customer the app.
 */
describe("apple-app-site-association", () => {
  it("🔴 claims /book/*, which is what every printed QR code encodes", async () => {
    // A shop's QR is `${appBase}/book/${shop.slug}` (dashboard/booking/
    // BookingManager.tsx). Until this path was listed, scanning a sticker on a
    // mirror opened Safari even on a phone with the app already installed -
    // the single most common way a customer meets ChairBack, and the app was
    // not in it.
    const body = await (await GET()).json();
    expect(body.applinks.details[0].paths).toContain("/book/*");
  });

  it("still claims the paths that were already live", async () => {
    // Narrowing any of these would break a link that works today: the customer
    // magic link, a team invitation, and the sign-in callback.
    const body = await (await GET()).json();
    const paths: string[] = body.applinks.details[0].paths;
    expect(paths).toContain("/r/*");
    expect(paths).toContain(`${MOBILE_APP.teamJoinPath}*`);
    expect(paths).toContain(`${MOBILE_APP.authCallbackPath}*`);
  });

  it("🔴 is served as application/json with a 200 and no redirect", async () => {
    // Apple rejects the AASA on any redirect or wrong content-type, and it
    // does so without telling anyone: universal links simply stop working.
    // That is why this is a route handler rather than a static file.
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("names the app as <TeamID>.<bundleId>", async () => {
    const body = await (await GET()).json();
    expect(body.applinks.details[0].appID).toBe(
      `ZLP9T7HSYJ.${MOBILE_APP.iosBundleId}`,
    );
  });
});
