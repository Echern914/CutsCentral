"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Self-cancellation from the emailed link. The token is the credential, so
 * there is no session here by design.
 *
 * Always resolves to ok: the API deliberately answers the same whether or not
 * the token matched, and surfacing a difference to the browser would rebuild
 * the oracle the API is careful not to be.
 */
export async function cancelWaitlistAction(token: string): Promise<{ ok: true }> {
  await apiPublicSend<{ ok: boolean }>(
    "POST",
    `/api/page/waitlist/cancel/${encodeURIComponent(token)}`,
    {},
  );
  return { ok: true };
}
