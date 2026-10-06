"use server";

import { apiPublicSend } from "@/lib/api";

export interface ClaimInput {
  email?: string;
}

export type ClaimActionResult =
  /** pending = an approval-mode shop: a REQUEST was submitted, not a booking. */
  | { ok: true; startsAt: string; shopSlug: string | null; pending: boolean }
  /** The hold lapsed (or was released/used) between page load and the tap. */
  | { ok: false; reason: "expired" }
  /** The physical time got taken through an overriding path. */
  | { ok: false; reason: "gone" }
  /** The shop switched on deposits mid-hold; book through their page instead. */
  | { ok: false; reason: "deposit" }
  /** The shop arranges this person's bookings itself (CONTACT_SHOP). The hold was let go. */
  | { ok: false; reason: "contact_shop" }
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
    pending: boolean;
  }>("POST", `/api/book/offer/${encodeURIComponent(token)}/claim`, {
    email: input.email?.trim() || undefined,
  });
  if (res.ok && res.data) {
    return {
      ok: true,
      startsAt: res.data.startsAt,
      shopSlug: res.data.shopSlug,
      pending: Boolean(res.data.pending),
    };
  }
  if (res.status === 410 || res.status === 404) return { ok: false, reason: "expired" };
  if (res.code === "CONTACT_SHOP") return { ok: false, reason: "contact_shop" };
  if (res.status === 409) {
    return { ok: false, reason: res.error === "deposit_required" ? "deposit" : "gone" };
  }
  return { ok: false, reason: "error" };
}

export type DeclineActionResult =
  /** left = they are also off the waitlist now. */
  | { ok: true; left: boolean }
  /** Already ended (lapsed, used, released): nothing left to pass on. */
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "error" };

/**
 * "No thanks": let the held time go to the next person now. With `leave`,
 * also come off the waitlist. The server decides everything from the token.
 */
export async function declineOfferAction(
  token: string,
  leave: boolean,
): Promise<DeclineActionResult> {
  const res = await apiPublicSend<{ ok: boolean; left: boolean }>(
    "POST",
    `/api/book/offer/${encodeURIComponent(token)}/decline`,
    { leave },
  );
  if (res.ok && res.data) return { ok: true, left: Boolean(res.data.left) };
  if (res.status === 410 || res.status === 404) return { ok: false, reason: "expired" };
  return { ok: false, reason: "error" };
}
