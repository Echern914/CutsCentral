"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Client self-serve SMS consent, called from the rewards page. These POST to the
 * public API via the server (the CSP blocks a direct browser fetch). The API
 * returns the new consent state, which the client component renders.
 */

export interface ConsentResult {
  ok: boolean;
  state?: "opted_in" | "opted_out";
  hasPhone?: boolean;
  error?: string;
}

export async function optInAction(
  magicToken: string,
  phone?: string,
): Promise<ConsentResult> {
  const res = await apiPublicSend<{
    consent: { state: "opted_in"; hasPhone: boolean };
  }>("POST", `/api/rewards/${magicToken}/opt-in`, phone ? { phone } : {});
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error ?? "failed" };
  }
  return { ok: true, ...res.data.consent };
}

export async function optOutAction(magicToken: string): Promise<ConsentResult> {
  const res = await apiPublicSend<{
    consent: { state: "opted_out"; hasPhone: boolean };
  }>("POST", `/api/rewards/${magicToken}/opt-out`, {});
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error ?? "failed" };
  }
  return { ok: true, ...res.data.consent };
}
