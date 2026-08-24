"use server";

import { apiPublicSend } from "@/lib/api";

export interface ClaimInput {
  email?: string;
}

export type ClaimActionResult =
  | { ok: true; startsAt: string; shopSlug: string | null }
  /** The hold lapsed (or was released/used) between page load and the tap. */
  | { ok: false; reason: "expired" }
  /** The physical time got taken through an overriding path. */
  | { ok: false; reason: "gone" }
  | { ok: false; reason: "error" };

/**
 * Redeem the claim token. The server re-derives EVERYTHING (shop, barber,
 * service, time) from the offer row the token hashes to - the browser can
 * only correct contact details, never point the claim at a different slot.
 */
export async function claimOfferAction(
  token: string,
  input: ClaimInput,
): Promise<ClaimActionResult> {
  const res = await apiPublicSend<{
    ok: boolean;
    startsAt: string;
    shopSlug: string | null;
  }>("POST", `/api/book/offer/${encodeURIComponent(token)}/claim`, {
    email: input.email?.trim() || undefined,
  });
  if (res.ok && res.data) {
    return { ok: true, startsAt: res.data.startsAt, shopSlug: res.data.shopSlug };
  }
  if (res.status === 410 || res.status === 404) return { ok: false, reason: "expired" };
  if (res.status === 409) return { ok: false, reason: "gone" };
  return { ok: false, reason: "error" };
}
