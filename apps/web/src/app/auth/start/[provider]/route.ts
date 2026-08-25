import { type NextRequest, NextResponse } from "next/server";
import { LOGIN_NEXT_ALLOWLIST, safeNextPath } from "@chairback/config/nextPath";
import { API_BASE } from "@/lib/api";
import { AUTH_COOKIE_OPTIONS, AUTH_NEXT_COOKIE } from "@/lib/authNext";

export const dynamic = "force-dynamic";

/**
 * The door to a social sign-in, on OUR origin rather than the API's.
 *
 * The buttons used to link straight at the API's /api/auth/google/start. That
 * works, but it leaves no moment on our own origin to remember where the
 * person was headed - so an invited barber who chose Google instead of a
 * password landed on /dashboard with their invitation forgotten, the same bug
 * the signup form had. One hop through here fixes it for every provider at
 * once: validate the destination, park it in a cookie, then hand off.
 *
 * The provider name is checked against a literal map rather than interpolated
 * into a URL, so this can never be turned into a redirector to an arbitrary
 * host by way of the path segment.
 */
const PROVIDER_START: Record<string, string> = {
  google: "/api/auth/google/start",
  apple: "/api/auth/apple/start",
};

export async function GET(
  req: NextRequest,
  { params }: { params: { provider: string } },
): Promise<NextResponse> {
  const startPath = PROVIDER_START[params.provider];
  if (!startPath) {
    return NextResponse.redirect(new URL("/login?error=unknown_provider", req.url));
  }

  const res = NextResponse.redirect(`${API_BASE}${startPath}`);
  const next = safeNextPath(
    req.nextUrl.searchParams.get("next"),
    LOGIN_NEXT_ALLOWLIST,
    "",
  );
  if (next) {
    res.cookies.set(AUTH_NEXT_COOKIE, next, AUTH_COOKIE_OPTIONS);
  } else {
    // No destination (or one that failed the allowlist): clear any stale value
    // so a previous attempt cannot redirect this one somewhere unexpected.
    res.cookies.set(AUTH_NEXT_COOKIE, "", { ...AUTH_COOKIE_OPTIONS, maxAge: 0 });
  }
  return res;
}
