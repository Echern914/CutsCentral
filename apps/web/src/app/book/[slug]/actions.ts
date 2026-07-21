"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";

export interface SlotsResult {
  timezone: string;
  slots: { startsAt: string; endsAt: string }[];
}

/** A single open instant, tagged with every staffId who can serve it. */
export interface MergedSlot {
  startsAt: string;
  // Staff free at this instant (>1 when several barbers offer the same time).
  staffIds: string[];
}

export interface MergedSlotsResult {
  timezone: string;
  slots: MergedSlot[];
}

/**
 * Fetch open slots across MANY staff for one service and merge them into a
 * single availability list keyed by instant, so the calendar can show "any
 * barber" availability without making the customer pick a provider first. The
 * slots API is strictly per-staff, so we fan out one request per staff (in
 * parallel) and union the results. `startsAt` carries the list of staff free at
 * that time; the booking submit picks one concrete staffId to write.
 *
 * Single-barber shops pass one id and this collapses to the plain per-staff
 * fetch — same data, one round-trip.
 */
export async function getMergedSlotsAction(
  slug: string,
  staffIds: string[],
  serviceId: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; data?: MergedSlotsResult; error?: string }> {
  if (staffIds.length === 0) return { ok: false, error: "no_staff" };
  const results = await Promise.all(
    staffIds.map(async (staffId) => {
      const qs = new URLSearchParams({ staffId, serviceId, from, to }).toString();
      const res = await apiPublicGet<SlotsResult>(
        `/api/book/${encodeURIComponent(slug)}/slots?${qs}`,
      );
      return { staffId, res };
    }),
  );
  // Tolerate partial failures: keep the barbers whose fetch succeeded and union
  // their availability. Dropping a flaky barber's slots preserves everyone
  // else's real openings; only a TOTAL failure (no barber returned) is fatal —
  // returning an error on any single hiccup would blank the whole calendar.
  const ok = results.filter((r) => r.res.ok && r.res.data);
  if (ok.length === 0) {
    const failed = results.find((r) => !r.res.ok);
    return { ok: false, error: failed?.res.error ?? "failed" };
  }
  const timezone = ok[0]!.res.data!.timezone;
  // Union by instant; accumulate which staff are free at each.
  const byInstant = new Map<string, Set<string>>();
  for (const { staffId, res } of ok) {
    for (const s of res.data!.slots) {
      const set = byInstant.get(s.startsAt) ?? new Set<string>();
      set.add(staffId);
      byInstant.set(s.startsAt, set);
    }
  }
  const slots: MergedSlot[] = [...byInstant.entries()]
    .map(([startsAt, set]) => ({ startsAt, staffIds: [...set] }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { ok: true, data: { timezone, slots } };
}

export interface BookInput {
  staffId: string;
  serviceId: string;
  startsAt: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  smsConsent: boolean;
  addOnIds?: string[];
  // Booking a barber-published targeted slot (fixed time/length/price).
  targetedSlotId?: string;
}

/**
 * Create a native booking. Returns the manage token on success so the UI can
 * link the customer to their cancel/reschedule page. A 409 maps to a friendly
 * "that time was just taken" so the picker can refresh slots. When the shop
 * charges at booking, `paymentClientSecret` is returned for the Payment Element
 * to confirm the card / Apple Pay.
 */
export async function bookAction(
  slug: string,
  input: BookInput,
): Promise<{
  ok: boolean;
  manageToken?: string;
  paymentClientSecret?: string | null;
  // true = the shop requires approval; this is a REQUEST awaiting confirmation.
  pending?: boolean;
  error?: string;
}> {
  const res = await apiPublicSend<{
    ok: boolean;
    manageToken: string;
    payment: { clientSecret: string } | null;
    pending?: boolean;
  }>("POST", `/api/book/${encodeURIComponent(slug)}`, input);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return {
    ok: true,
    manageToken: res.data.manageToken,
    paymentClientSecret: res.data.payment?.clientSecret ?? null,
    pending: Boolean(res.data.pending),
  };
}

export interface WaitlistInput {
  firstName: string;
  phone?: string;
  email?: string;
  serviceId?: string;
  staffId?: string;
  preferredTime?: string;
  note?: string;
}

/**
 * Join the shop's waitlist. serviceId/staffId are passed when the join comes
 * from a fully-booked day so the barber knows exactly what the customer wants.
 */
export async function joinWaitlistAction(
  slug: string,
  input: WaitlistInput,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend<{ ok: boolean }>(
    "POST",
    `/api/page/${encodeURIComponent(slug)}/waitlist`,
    input,
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}
