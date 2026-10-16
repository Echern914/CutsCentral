import { redirect } from "next/navigation";
import { SELECTABLE_BUSINESS_TYPE_IDS, type BusinessTypeId } from "@chairback/config/businessTypes";
import { apiGet } from "@/lib/api";
import { ShopForm } from "./ShopForm";
import { getOnboardingState, resumeHref } from "./state";

/**
 * FIRST-TIME SETUP starts here, and comes back here. A shop that is set up
 * goes to its dashboard; one half way through goes to the first thing it is
 * still missing (config/onboarding.ts); only someone with no shop of their own
 * sees the form.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: { type?: string };
}) {
  const state = await getOnboardingState();
  if (state) redirect(state.shop.completedAt ? "/dashboard" : resumeHref(state));

  const me = await apiGet<{ smsAttested?: boolean }>("/api/auth/me");
  const type = searchParams?.type ?? "";
  const initialType = (SELECTABLE_BUSINESS_TYPE_IDS as readonly string[]).includes(type) ? (type as BusinessTypeId) : "";
  return <ShopForm smsAttested={me.data?.smsAttested === true} initialType={initialType} />;
}
