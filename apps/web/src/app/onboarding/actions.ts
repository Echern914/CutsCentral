"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AFFILIATE_CLAIM_COOKIE } from "@chairback/config";
import { PARTNER_CODE_ERROR_COPY } from "@chairback/config/partnerProgram";
import { apiGet, apiSend } from "@/lib/api";
import { clearActiveShopCookie } from "@/lib/activeShopCookie";
import { mintAppReturnUrl } from "@/lib/mobileReturn";
import { TEAM_LINK_COOKIE, clearTeamLinkCookie, teamKeyOk } from "@/lib/teamLinkCookie";

interface ShopState {
  error?: string;
  /** Which field the error is about, when it is about one. */
  field?: "partnerCode";
}

export async function createShopAction(
  _prev: ShopState,
  formData: FormData,
): Promise<ShopState> {
  // SMS attestation is required to create a shop (the API enforces it too).
  // Someone who signed up with a password gave it on the signup form, so the
  // form doesn't ask twice; Google and Apple sign-in skip that form, and are
  // asked here. Read from the account, never trusted from the form.
  const me = await apiGet<{ smsAttested?: boolean }>("/api/auth/me");
  if (me.data?.smsAttested !== true && formData.get("smsAttested") !== "on") {
    return { error: "Please confirm the SMS consent statement to continue." };
  }
  // 🔴 No `?? "other"` fallback. The picker is `required` and deliberately has no
  // default, so a missing value means the question was not answered - and
  // inventing an answer here is exactly the silent classification the business
  // type design exists to prevent. Omitting the field creates an UNSELECTED shop
  // that renders neutral wording and gets asked once, which is the honest result.
  const industry = String(formData.get("industry") ?? "").trim();
  const partnerCode = String(formData.get("partnerCode") ?? "").trim();
  // How clients book is its own step next; the reward is set up when Rewards
  // is switched on (the API seeds its default for the business type).
  const res = await apiSend("POST", "/api/shops", {
    name: String(formData.get("name") ?? ""),
    ...(industry ? { industry } : {}),
    timezone: String(formData.get("timezone") ?? "America/New_York"),
    smsAttested: true,
    ...(partnerCode ? { partnerCode } : {}),
  });
  // A referral code that can't be used stops here with its reason, before any
  // business exists - never a silent "continued without it".
  const codeError = res.status === 400 && res.error ? PARTNER_CODE_ERROR_COPY[res.error] : undefined;
  if (codeError) return { error: codeError, field: "partnerCode" };
  if (!res.ok && res.status !== 409) {
    return { error: onboardingRefusal(res) };
  }
  // The affiliate claim (if any) travelled with this request - apiSend forwards
  // this origin's cookies - and the shop it applied to now exists, so the claim
  // is spent. Clearing it keeps a stale claim from following the same browser
  // into somebody else's signup on a shared machine. The database is what
  // actually guarantees one attribution per shop; this is hygiene, not the
  // guard, and a failure to clear costs nothing.
  cookies().delete(AFFILIATE_CLAIM_COOKIE);
  // Work in the shop they just made. Someone who joined a team first has the
  // team's shop as this browser's active shop, and the rest of onboarding
  // (connecting a calendar, payments) must land on THEIR business, not the team's.
  clearActiveShopCookie();
  await askTheTeamTheyCameFor();
  // If the native app started this in the system browser, the shop now EXISTS
  // and this is the moment to hand the session back. Same ordering rule as the
  // team invitation: what they came to do is done and committed before any of
  // this runs, so a failed trip home costs them a tap, never their shop.
  //
  // It waits until here and not a step earlier because a session handed back
  // before the shop existed would drop the owner into the shop-creation wizard
  // inside the app shell - the business registration Guideline 3.1.1 keeps out
  // of it. What remains of onboarding (connect a calendar, and so on) is
  // optional polish they can finish in the app on a real dashboard.
  const returnUrl = await mintAppReturnUrl("new_shop");
  redirect(returnUrl ?? "/onboarding/booking");
}

/**
 * They opened a shop's team link with no business, and set one up to join.
 * Now it exists, so the request goes HERE - every way through onboarding
 * passes this point, while the last screen can be skipped (the connect step
 * has an exit straight to the dashboard, and the app hand-off returns early).
 * Asking grants nothing: the owner approves, nothing is shared until the
 * barber chooses.
 *
 * Once the API has answered for good (sent, already asked, or no such team)
 * the cookie is forgotten, so it can never ask again - least of all for the
 * next person to sign up in this browser. A failure that might pass (the
 * network, a 5xx) keeps it, and the last screen offers the request again.
 */
async function askTheTeamTheyCameFor(): Promise<void> {
  const team = cookies().get(TEAM_LINK_COOKIE)?.value;
  if (!teamKeyOk(team)) return;
  const res = await apiSend("POST", "/api/teams/join", { team });
  if (res.ok || res.status === 409 || res.status === 404) clearTeamLinkCookie();
}

/**
 * Which part of step 1 the API refused, named - not "Check the booking URL"
 * for every refusal, including ones that had nothing to do with a URL.
 */
function onboardingRefusal(res: { error?: string; issues?: { path: (string | number)[] }[] }): string {
  const field = res.issues?.[0]?.path?.[0];
  if (res.error === "invalid_input") {
    if (field === "name") return "Keep the shop name under 120 characters.";
    if (field === "timezone") return "Pick your time zone from the list.";
  }
  return "Could not create your shop. Check the details and try again.";
}
