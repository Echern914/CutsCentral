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

// NOTE: the API exposes POST /api/book/manage/:token/reschedule (validated +
// availability-checked), but V1's manage page uses cancel-and-rebook instead of
// an in-page slot picker (the manage GET doesn't expose staff/service ids needed
// to render one). The reschedule client action is intentionally omitted until
// that UI exists, to avoid an unwired export.
