import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { API_BASE } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Google OAuth landing. The API (different origin) can't set our session
 * cookie, so its callback redirects here with a 60-second signed handoff code.
 * We exchange it server-to-server for a real session token and set the cookie
 * on THIS origin - the long-lived token never appears in any URL.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=google_failed", req.url));
  }

  const res = await fetch(`${API_BASE}/api/auth/google/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.redirect(new URL("/login?error=google_failed", req.url));
  }

  const { token } = (await res.json()) as { token?: string };
  if (!token) {
    return NextResponse.redirect(new URL("/login?error=google_failed", req.url));
  }

  // New users (no shop yet) get bounced from /dashboard to /onboarding.
  const redirect = NextResponse.redirect(new URL("/dashboard", req.url));
  redirect.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return redirect;
}
