"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

/** Ask ChairBack to pay out part of a partner balance. The API owns every rule. */
export async function requestCashoutAction(
  amountCents: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", "/api/partner/me/cashouts", { amountCents });
  revalidatePath("/dashboard/referrals");
  return { ok: res.ok, error: res.error };
}
