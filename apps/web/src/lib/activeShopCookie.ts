import { cookies, headers } from "next/headers";
import { ACTIVE_SHOP_COOKIE_NAME } from "@chairback/config/constants";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

/**
 * This browser's active-shop choice. Server-action use only - shared by the
 * shop switcher and by accepting a team invitation.
 *
 * Written host-only AND domain-wide (mirroring the session cookie) so API-origin
 * navigations carry the selection too. Only ever a HINT: the API re-verifies it
 * against ownership or a team seat on every request, so a stale or forged id
 * falls back to the person's own shop, never someone else's.
 */
const OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
} as const;

export function setActiveShopCookie(shopId: string): void {
  cookies().set(ACTIVE_SHOP_COOKIE_NAME, shopId, OPTIONS);
  const domain = sessionCookieDomain(headers().get("host"));
  if (domain) cookies().set(ACTIVE_SHOP_COOKIE_NAME, shopId, { ...OPTIONS, domain });
}
