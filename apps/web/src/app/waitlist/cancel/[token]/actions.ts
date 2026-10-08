"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Self-cancellation from the emailed link. The token is the credential, so
 * there is no session here by design.
 *
 * `ok` is whether the request REACHED the API - never whether the token
 * matched. The API answers 200 the same either way (it must not become an
 * oracle), so passing its transport result on leaks nothing. Swallowing it
 * meant a dropped request said "You're off the list" while they stayed on it.
 */
export async function cancelWaitlistAction(token: string): Promise<{ ok: boolean }> {
  const res = await apiPublicSend<{ ok: boolean }>(
    "POST",
    `/api/page/waitlist/cancel/${encodeURIComponent(token)}`,
    {},
  );
  return { ok: res.ok };
}
