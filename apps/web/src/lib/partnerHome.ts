import { apiGet } from "@/lib/api";

/**
 * Where a signed-in login with NO business of its own lands.
 *
 * Normally that is "set up your shop". But a partner - someone ChairBack pays
 * for bringing businesses in - may run no business here at all, and their
 * earnings page is the only place they can see their balance or ask to be
 * paid. So a partner lands there, with setting up a business one tap away.
 */
export async function homeWithoutShop(): Promise<"/dashboard/referrals" | "/onboarding"> {
  const partner = await apiGet<unknown>("/api/partner/me");
  return partner.ok ? "/dashboard/referrals" : "/onboarding";
}
