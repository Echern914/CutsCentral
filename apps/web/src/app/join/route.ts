import { NextResponse, type NextRequest } from "next/server";
import {
  AFFILIATE_CLAIM_COOKIE,
  normalizeAffiliateCode,
} from "@chairback/config";
import { apiPublicSend } from "@/lib/api";
import { signupTargetPath } from "@/lib/affiliateJoin";

/**
 * The referral link: getchairback.com/join?ref=CODE
 *
 * A route handler rather than a page because this leg's whole job is to SET A
 * COOKIE, which a server component cannot do. The code is validated by the API
 * (the browser is never told whether it was any good) and, if it resolves to
 * an eligible affiliate, the signed claim it mints is parked in an HttpOnly
 * cookie on THIS origin. The visitor then continues to signup.
 *
 * 🔴 The claim lives on the web origin and never travels anywhere else. That
 * is what lets attribution survive Google and Apple sign-in without putting
 * anything into the OAuth `state`: the provider round trip does not touch this
 * cookie, and the web server later forwards it to the API when it creates the
 * shop. See services/affiliateAttribution.ts for the whole trust boundary.
 *
 * While the program is dark the API answers 404 and so does this route -
 * indistinguishable from a page that does not exist.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const code = normalizeAffiliateCode(url.searchParams.get("ref"));
  const target = signupTargetPath(url.searchParams);

  // No usable code in the link: offer the manual route rather than a dead end.
  // Someone who saw the code on another device lands here too.
  if (!code) {
    return NextResponse.redirect(new URL("/join/enter", url.origin), 302);
  }

  const res = await apiPublicSend<{ claim: string | null; maxAgeSeconds: number }>(
    "POST",
    "/api/affiliate/claim",
    { code, source: "link" },
  );

  // Program dark - this surface does not exist.
  if (res.status === 404) {
    return new NextResponse(null, { status: 404 });
  }

  const response = NextResponse.redirect(new URL(target, url.origin), 302);
  const claim = res.data?.claim;
  // An unknown or ineligible code lands the visitor on signup all the same,
  // with no cookie and no explanation: the page must not become an oracle for
  // which codes are real.
  if (typeof claim === "string" && claim.length > 0) {
    response.cookies.set(AFFILIATE_CLAIM_COOKIE, claim, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: res.data?.maxAgeSeconds ?? 0,
    });
  }
  return response;
}
