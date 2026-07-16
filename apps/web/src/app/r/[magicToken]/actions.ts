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

/**
 * Client self-reports their haircut cadence (the one-tap prompt). The API
 * validates the key against the allowed set; we just relay ok/error. The page
 * then re-fetches so the personalized rebook countdown reflects the new cadence.
 */
export async function setCadenceAction(
  magicToken: string,
  cadence: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend<{ ok: boolean; cadence: string }>(
    "POST",
    `/api/rewards/${magicToken}/cadence`,
    { cadence },
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}

/**
 * Client self-serve data deletion (App Store 5.1.1(v)). Anonymizes the client's
 * data server-side and voids this magic link; the page then shows a terminal
 * "deleted" state (re-fetching would 404 - the link is gone).
 */
export async function deleteMyDataAction(
  magicToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend<{ ok: boolean }>(
    "POST",
    `/api/rewards/${magicToken}/delete`,
    {},
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}
