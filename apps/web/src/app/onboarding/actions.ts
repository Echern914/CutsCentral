"use server";

import { redirect } from "next/navigation";
import { apiSend } from "@/lib/api";
import { mintAppReturnUrl } from "@/lib/mobileReturn";

interface ShopState {
  error?: string;
}

export async function createShopAction(
  _prev: ShopState,
  formData: FormData,
): Promise<ShopState> {
  // SMS attestation is required to create a shop (the API enforces it too).
  // This is the consent gate for the Google sign-in path, which skips the
  // signup form where password users already attested.
  if (formData.get("smsAttested") !== "on") {
    return { error: "Please confirm the SMS consent statement to continue." };
  }
  // 🔴 No `?? "other"` fallback. The picker is `required` and deliberately has no
  // default, so a missing value means the question was not answered - and
  // inventing an answer here is exactly the silent classification the business
  // type design exists to prevent. Omitting the field creates an UNSELECTED shop
  // that renders neutral wording and gets asked once, which is the honest result.
  const industry = String(formData.get("industry") ?? "").trim();
  const res = await apiSend("POST", "/api/shops", {
    name: String(formData.get("name") ?? ""),
    ...(industry ? { industry } : {}),
    bookingUrl: String(formData.get("bookingUrl") ?? ""),
    timezone: String(formData.get("timezone") ?? "America/New_York"),
    rewardThreshold: Number(formData.get("rewardThreshold") ?? 10),
    rewardLabel: String(formData.get("rewardLabel") ?? "").trim() || undefined,
    smsAttested: true,
  });
  if (!res.ok && res.status !== 409) {
    return { error: "Could not create your shop. Check the booking URL." };
  }
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
  redirect(returnUrl ?? "/onboarding/connect");
}
