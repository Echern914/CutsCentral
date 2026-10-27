"use server";

import { apiSend } from "@/lib/api";

/**
 * "Agree and continue" on the dashboard's Before-you-continue screen. The API
 * stamps the version it serves; the body carries the tick itself so a stray
 * POST is never an agreement.
 */
export async function acceptTermsAction(): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("POST", "/api/auth/accept-terms", { acceptTerms: true });
  return { ok: res.ok };
}
