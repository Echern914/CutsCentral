"use server";

import { apiPublicSend } from "@/lib/api";

/** Cancel a booking by its manage token (customer-initiated, no login). */
export async function cancelBookingAction(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/cancel`,
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}

/**
 * "On my way" check-in (customer-initiated, no login). One-way: the API only
 * ever writes 'en_route'; re-posting refreshes the optional ETA chips.
 */
export async function checkInAction(
  token: string,
  opts?: { etaMinutes?: 5 | 10 | 15; runningLate?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/checkin`,
    opts ?? {},
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}

/** One-tap decline to a barber "come early" nudge (pushes back to the barber). */
export async function nudgeReplyAction(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/nudge-reply`,
    { reply: "cant_make_it_early" },
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}

// NOTE: the API exposes POST /api/book/manage/:token/reschedule (validated +
// availability-checked), but V1's manage page uses cancel-and-rebook instead of
// an in-page slot picker (the manage GET doesn't expose staff/service ids needed
// to render one). The reschedule client action is intentionally omitted until
// that UI exists, to avoid an unwired export.
