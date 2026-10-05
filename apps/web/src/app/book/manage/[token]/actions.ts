"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";
import type { TipView } from "./page";

/**
 * Cancel a booking by its manage token (customer-initiated, no login).
 * scope "future" - a standing appointment only - also cancels every later
 * visit in the series.
 */
export async function cancelBookingAction(
  token: string,
  scope: "this" | "future" = "this",
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/cancel`,
    { scope },
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}

/**
 * Stop the shop charging the saved card for the service (customer-initiated,
 * no login). One-way on purpose: nothing - not the customer, not the shop -
 * can switch it back on.
 */
export async function stopServiceChargesAction(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/stop-service-charges`,
    {},
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}

/**
 * Take the saved card off the shop's file - the promise the save-card consent
 * made. Appointments already booked with it keep it until they are done; it is
 * never offered again.
 */
export async function removeSavedCardAction(token: string): Promise<{ ok: boolean }> {
  const res = await apiPublicSend(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/saved-card/remove`,
    {},
  );
  return { ok: res.ok };
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

/**
 * Start (or resume) a tip after the visit. The SERVER decides whether a tip
 * may be taken and turns the amount into a payment; the page only gets the
 * client secret for the card form. Fields mapped one by one: the API seam
 * drops unknown fields from an error, and a 202 "unconfirmed" is HTTP-ok while
 * the payment is not ready.
 */
export async function startTipAction(
  token: string,
  amountCents: number,
): Promise<{ ok: boolean; clientSecret?: string; amountCents?: number; error?: string; reason?: string }> {
  const res = await apiPublicSend<{ clientSecret?: string; amountCents?: number; result?: string }>(
    "POST",
    `/api/book/manage/${encodeURIComponent(token)}/tip`,
    { amountCents },
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed", reason: res.reason };
  if (!res.data?.clientSecret) return { ok: false, error: res.data?.result ?? "unconfirmed" };
  return { ok: true, clientSecret: res.data.clientSecret, amountCents: res.data.amountCents };
}

/** Where the visit's tip stands - polled after paying, so "thank you" is true. */
export async function tipStatusAction(
  token: string,
): Promise<{ ok: boolean; tip?: TipView | null }> {
  const res = await apiPublicGet<{ tip: TipView | null }>(
    `/api/book/manage/${encodeURIComponent(token)}/tip`,
  );
  if (!res.ok || !res.data) return { ok: false };
  return { ok: true, tip: res.data.tip };
}
