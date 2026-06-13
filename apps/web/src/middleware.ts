import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";

/**
 * Route gate for /dashboard and /onboarding. This is a UX presence check only -
 * the API re-verifies the signed cookie on every request (the real gate). We
 * don't verify the HMAC here to keep the Edge middleware dependency-free.
 */
export function middleware(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/onboarding/:path*", "/admin/:path*"],
};
