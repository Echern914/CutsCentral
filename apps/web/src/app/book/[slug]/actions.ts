"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";

export interface SlotsResult {
  timezone: string;
  slots: { startsAt: string; endsAt: string; maxExtraMin: number }[];
}

/** A single open instant, tagged with every staffId who can serve it. */
export interface MergedSlot {
  startsAt: string;
  // Staff free at this instant (>1 when several barbers offer the same time).
  staffIds: string[];
  /**
   * Spare minutes after the service at this start — how much room there is to
   * offer add-ons. Belongs to staffIds[0], the barber the booking is written
   * against, because room is per-barber: one may be free until close while the
   * next has a client 20 minutes later.
   */
  maxExtraMin: number;
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
  // Union by instant; accumulate which staff are free at each, keeping each
  // one's own spare room alongside so the pair can't drift (the booking is
  // written against staffIds[0], so the upsell must describe THAT barber's gap
  // — taking a max across barbers would promise room the assigned one lacks).
  const byInstant = new Map<string, { staffId: string; maxExtraMin: number }[]>();
  for (const { staffId, res } of ok) {
    for (const s of res.data!.slots) {
      const list = byInstant.get(s.startsAt) ?? [];
      list.push({ staffId, maxExtraMin: s.maxExtraMin });
      byInstant.set(s.startsAt, list);
    }
  }
  const slots: MergedSlot[] = [...byInstant.entries()]
    .map(([startsAt, free]) => ({
      startsAt,
      staffIds: free.map((f) => f.staffId),
      maxExtraMin: free[0]!.maxExtraMin,
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { ok: true, data: { timezone, slots } };
}

/** One service's openings on a single day (day-first bundles view). */
export interface DayService {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  color: string | null;
  durationMin: number; // resolved for THAT day (weekday overrides)
  price: number | null; // resolved for THAT day
  slots: {
    startsAt: string;
    staffIds: string[];
    targeted?: { id: string; price: number; label: string | null };
    // Present ONLY when a time-of-day window makes this slot differ from the
    // day-level price/durationMin above (e.g. the 9 PM chip is $65 / 20 min).
    price?: number | null;
    durationMin?: number;
    /** Spare minutes after this service here — drives the add-on offer.
     *  Absent on a targeted slot: its length is fixed inventory. */
    maxExtraMin?: number;
  }[];
}

export interface DayBundlesResult {
  timezone: string;
  date: string;
  // Only bundles/services with at least one opening that day.
  bundles: { id: string; name: string; services: DayService[] }[];
  ungrouped: DayService[];
}

/** Everything bookable on one shop-local day, grouped by bundle. */
export async function getDayBundlesAction(
  slug: string,
  date: string,
): Promise<{ ok: boolean; data?: DayBundlesResult; error?: string }> {
  const res = await apiPublicGet<DayBundlesResult>(
    `/api/book/${encodeURIComponent(slug)}/day?date=${encodeURIComponent(date)}`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

/** One "you have time for more" offer: a longer, dearer service at the SAME time. */
export interface UpgradeOffer {
  serviceId: string;
  name: string;
  description: string | null;
  durationMin: number;
  price: number;
  /** How much more than the service the customer already picked. */
  priceDelta: number;
  /** How much longer it runs. */
  extraMin: number;
}

export interface UpgradesResult {
  /** Spare minutes after the chosen service at this exact slot. */
  maxExtraMin: number;
  upgrades: UpgradeOffer[];
}

/**
 * What else the customer could book at the slot they just tapped.
 *
 * Every offer here is confirmed by the booking engine for that exact instant,
 * barber and service — NOT inferred from the size of the gap. A longer service
 * steps its own slot grid and carries its own hours and group caps, so "the gap
 * is big enough" can still be a time the booking POST refuses. Suggesting one
 * of those would dead-end the customer at the last step of the flow.
 *
 * Failure is silent by design: an upsell that can't load is simply not shown.
 */
export async function getUpgradesAction(
  slug: string,
  input: { startsAt: string; staffId: string; serviceId: string },
): Promise<UpgradesResult | null> {
  const qs = new URLSearchParams(input).toString();
  const res = await apiPublicGet<UpgradesResult>(
    `/api/book/${encodeURIComponent(slug)}/upgrades?${qs}`,
  );
  return res.ok && res.data ? res.data : null;
}

export interface OpenDaysResult {
  timezone: string;
  // How many days ahead the API scanned (its cap or bookingMaxDays, whichever
  // is smaller). Days beyond this weren't checked — don't grey them.
  scanDays: number;
  // Shop-local YYYY-MM-DD days with at least one real opening, sorted.
  openDays: string[];
  // The single earliest bookable slot across every service, if any.
  soonest: {
    date: string; // shop-local YYYY-MM-DD
    startsAt: string; // ISO instant
    serviceId: string;
    staffIds: string[];
  } | null;
}

/**
 * Which days actually have an opening (real engine, not the weekday
 * heuristic) + the soonest bookable slot. Drives the day-first calendar's
 * greying, its auto-selected landing day, and the "Soonest available" chip.
 */
export async function getOpenDaysAction(
  slug: string,
): Promise<{ ok: boolean; data?: OpenDaysResult; error?: string }> {
  const res = await apiPublicGet<OpenDaysResult>(
    `/api/book/${encodeURIComponent(slug)}/open-days`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
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
  /** A standing appointment: this time, every `interval` weeks, `count` times. */
  recurrence?: { interval: number; count: number };
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
  /** "payment" (charge now) or "setup" (card kept, nothing charged). */
  paymentKind?: "payment" | "setup";
  /** What is actually being charged now, in cents (deposit < full price). */
  paymentAmountCents?: number | null;
  /** True when this is a DEPOSIT and money is still owed at the shop. */
  paymentIsDeposit?: boolean;
  /** Cents still due in person after this charge. */
  paymentBalanceDueCents?: number | null;
  /**
   * How many minutes the chair is held while they pay. The appointment is a
   * HOLD until the payment lands, so this is a real deadline, not decoration -
   * the customer is entitled to know how long they have.
   */
  paymentHoldMinutes?: number | null;
  /**
   * The instant the chair goes back on sale, so the screen can count DOWN. A
   * minute count is only true at the moment it is rendered; a customer who
   * switches apps to fetch their card comes back to a number that has been
   * lying to them ever since.
   */
  paymentExpiresAt?: string | null;
  // true = the shop requires approval; this is a REQUEST awaiting confirmation.
  pending?: boolean;
  /**
   * For a standing appointment: how many of the requested visits actually
   * landed. `skipped` lists the dates that were already taken, so the screen
   * can name them rather than let a missing March reminder be the first hint.
   */
  series?: { booked: number; total: number; skipped: string[] };
  error?: string;
}> {
  const res = await apiPublicSend<{
    ok: boolean;
    manageToken: string;
    payment: {
      /** "payment" moves money now; "setup" keeps the card and charges nothing. */
      kind?: "payment" | "setup";
      clientSecret: string;
      amountCents: number;
      isDeposit: boolean;
      balanceDueCents: number;
      holdMinutes?: number;
      expiresAt?: string | null;
    } | null;
    pending?: boolean;
    series?: {
      booked: number;
      total: number;
      skipped: { startsAt: string; reason: string }[];
    };
  }>("POST", `/api/book/${encodeURIComponent(slug)}`, input);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return {
    ok: true,
    manageToken: res.data.manageToken,
    series: res.data.series
      ? {
          booked: res.data.series.booked,
          total: res.data.series.total,
          skipped: res.data.series.skipped.map((k) => k.startsAt),
        }
      : undefined,
    paymentClientSecret: res.data.payment?.clientSecret ?? null,
    paymentKind: res.data.payment?.kind ?? "payment",
    paymentAmountCents: res.data.payment?.amountCents ?? null,
    paymentIsDeposit: res.data.payment?.isDeposit ?? false,
    paymentBalanceDueCents: res.data.payment?.balanceDueCents ?? null,
    paymentHoldMinutes: res.data.payment?.holdMinutes ?? null,
    paymentExpiresAt: res.data.payment?.expiresAt ?? null,
    pending: Boolean(res.data.pending),
  };
}

/**
 * Has the booking actually been confirmed yet?
 *
 * 🔴 WHY THE CLIENT CANNOT JUST TRUST `confirmPayment`. Stripe telling the
 * BROWSER the payment succeeded is not the same fact as ChairBack having a
 * booking. The appointment is written as a HOLD and is promoted to BOOKED only
 * when `payment_intent.succeeded` reaches our webhook
 * (billing/payments.ts -> promotePaidHold). Until then the chair is still on a
 * ten-minute fuse, and the sweep cancels it with no notification whatsoever.
 *
 * The old screen declared "You're booked!" straight off the browser's return
 * value, so a webhook that was slow, or a payment that went to `processing`
 * and later failed, produced a customer holding a confirmation page for an
 * appointment that quietly no longer existed.
 *
 * This asks the one authority that knows. The client polls it for a few
 * seconds after paying; the answer is the appointment's real status.
 */
export async function bookingStatusAction(
  token: string,
): Promise<{ ok: boolean; status?: string }> {
  const res = await apiPublicGet<{ status: string }>(
    `/api/book/manage/${encodeURIComponent(token)}`,
  );
  if (!res.ok || !res.data) return { ok: false };
  return { ok: true, status: res.data.status };
}

/** A date+time preference. Null on either half means ANY for that half. */
export interface WaitlistWindowInput {
  startDate: string | null;
  endDate: string | null;
  startMin: number | null;
  endMin: number | null;
}

export interface WaitlistInput {
  firstName: string;
  phone?: string;
  email?: string;
  serviceId?: string;
  staffId?: string;
  preferredTime?: string;
  note?: string;
  /** The customer's IANA zone, so "Saturday morning" means their morning. */
  timezone?: string;
  /** Omitted = one "Any date / Any time" window, i.e. the old behaviour. */
  windows?: WaitlistWindowInput[];
  /** 🔴 Only ever true from an explicit tick. Absent is not consent. */
  smsConsent?: boolean;
}

/**
 * Join the shop's waitlist. serviceId/staffId are passed when the join comes
 * from a fully-booked day so the barber knows exactly what the customer wants.
 */
export async function joinWaitlistAction(
  slug: string,
  input: WaitlistInput,
): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
  const res = await apiPublicSend<{ ok: boolean; duplicate?: boolean }>(
    "POST",
    `/api/page/${encodeURIComponent(slug)}/waitlist`,
    input,
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  // A duplicate is success from the customer's side - they ARE on the list.
  return { ok: true, duplicate: res.data?.duplicate === true };
}
