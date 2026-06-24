import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { WelcomeFlow } from "./WelcomeFlow";

interface ShopMe {
  connected: boolean;
}

/**
 * First-run guided tour. The dashboard redirects brand-new barbers here
 * (welcomeSeen=false) instead of rendering inline, and the account card links
 * here with ?replay=1 for a refresher.
 *
 * Guards mirror the dashboard: this is a top-level route, so it doesn't inherit
 * the dashboard layout's auth gate and must do its own.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: { replay?: string };
}) {
  const replay = searchParams.replay === "1";

  const [me, shopRes] = await Promise.all([getMe(), apiGet<ShopMe>("/api/shops/me")]);

  if (me.status === 401 || shopRes.status === 401) redirect("/login");
  // No shop yet - they belong in onboarding, not the feature tour.
  if (shopRes.status === 404) redirect("/onboarding");
  if (!shopRes.ok || !shopRes.data) throw new Error("Failed to load your shop");

  // Already toured and not explicitly replaying? Don't make /welcome a place you
  // can get re-stuck - send them straight to the dashboard.
  if (me.data?.welcomeSeen && !replay) redirect("/dashboard");

  return <WelcomeFlow connected={shopRes.data.connected} replay={replay} />;
}
