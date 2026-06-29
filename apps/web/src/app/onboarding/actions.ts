"use server";

import { redirect } from "next/navigation";
import { apiSend } from "@/lib/api";

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
  const res = await apiSend("POST", "/api/shops", {
    name: String(formData.get("name") ?? ""),
    industry: String(formData.get("industry") ?? "other"),
    bookingUrl: String(formData.get("bookingUrl") ?? ""),
    timezone: String(formData.get("timezone") ?? "America/New_York"),
    rewardThreshold: Number(formData.get("rewardThreshold") ?? 10),
    rewardLabel: String(formData.get("rewardLabel") ?? "").trim() || undefined,
    smsAttested: true,
  });
  if (!res.ok && res.status !== 409) {
    return { error: "Could not create your shop. Check the booking URL." };
  }
  redirect("/onboarding/connect");
}
