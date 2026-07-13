import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { DASHBOARD_TOUR_STEPS } from "@chairback/config/demoTour";
import { API_BASE } from "@/lib/api";
import { pathForDashboardTourRoute } from "@/components/tour/tourPaths";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

/**
 * The barber-side demo's front door. Anonymous prospects get a READ-ONLY demo
 * session for the demo tenant (minted by the API with the `demo` claim — every
 * mutating request is rejected server-side) and land on the dashboard with the
 * dashboard tour armed. A visitor who already has a session cookie keeps it and
 * just gets the tour on their own dashboard — never silently logged out into
 * the demo account.
 */
export async function GET(request: Request): Promise<Response> {
  // Optional deep link into the middle of the dashboard tour (?step=N or a
  // step id like ?step=dash-agenda) — mirrors the /demo entry's behavior.
  const raw = new URL(request.url).searchParams.get("step");
  let step = 1;
  if (raw !== null) {
    const byId = DASHBOARD_TOUR_STEPS.findIndex((s) => s.id === raw) + 1;
    const n = byId > 0 ? byId : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= DASHBOARD_TOUR_STEPS.length) step = n;
  }
  const landing = `${pathForDashboardTourRoute(DASHBOARD_TOUR_STEPS[step - 1]!.route)}?tour=${step}`;

  const hasSession = Boolean(cookies().get(SESSION_COOKIE_NAME)?.value);
  if (!hasSession) {
    const res = await fetch(`${API_BASE}/api/demo/session`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) {
      // No demo tenant on this environment — fall back to the client demo.
      redirect("/demo");
    }
    // Copy the API's session cookie onto the web origin (host-only + domain-
    // wide), mirroring the login action's applySessionCookie.
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
    const value = match?.[1];
    if (!value) redirect("/demo");
    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 2, // matches the API demo-session TTL
    } as const;
    cookies().set(SESSION_COOKIE_NAME, value!, options);
    const domain = sessionCookieDomain(headers().get("host"));
    if (domain) cookies().set(SESSION_COOKIE_NAME, value!, { ...options, domain });
  }
  redirect(landing);
}
