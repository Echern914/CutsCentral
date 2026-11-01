"use server";

import { apiSend } from "@/lib/api";

/**
 * A one-time code that opens billing in Safari already signed in, in the shop
 * the app is showing (API routes/billing.ts POST /handoff). Null when it can't
 * be had - the button then opens billing signed out, which still works for
 * anyone with a Google login or a password.
 */
export async function startBillingHandoffAction(): Promise<string | null> {
  const res = await apiSend<{ code: string }>("POST", "/api/billing/handoff");
  return res.ok && typeof res.data?.code === "string" ? res.data.code : null;
}
