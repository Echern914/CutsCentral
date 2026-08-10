"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";

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

/**
 * The open times this booking can move to (same barber, same service). The
 * manage token is the authorization, so the browser never handles staff or
 * service ids - see GET /api/book/manage/:token/slots.
 */
export async function rescheduleOptionsAction(
  token: string,
): Promise<{ timezone: string; slots: string[] } | null> {
  const res = await apiPublicGet<{
    timezone: string;
    slots: { startsAt: string }[];
  }>(`/api/book/manage/${encodeURIComponent(token)}/slots`);
  if (!res.ok || !res.data) return null;
  return {
    timezone: res.data.timezone,
    slots: res.data.slots.map((s) => s.startsAt),
  };
}

/**
 * Move the booking to a new time in ONE call. This replaces the old
 * cancel-and-rebook instruction, which asked the customer to do two things in
 * the right order and punished both mistakes: rebook-then-forget-to-cancel
 * left a phantom appointment holding a slot the barber couldn't sell, and
 * cancel-first lost the original time if the new one was gone by the time they
 * got there. The API re-checks availability under the same overlap guard the
 * create path uses, so a slot taken between render and tap comes back as
 * `slot_taken` rather than a double-book.
 */
export async function rescheduleBookingAction(
  token: string,
  startsAt: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/reschedule`,
    { startsAt },
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}
