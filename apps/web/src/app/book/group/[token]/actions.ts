"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";
import type { GroupPlanResult } from "../../[slug]/group/actions";

/**
 * Server actions for managing a booked party.
 *
 * 🔴 THE TOKEN NEVER LEAVES THE SERVER SIDE OF THESE CALLS, AND IS NEVER
 * LOGGED. It is a bearer credential: whoever holds it can move or cancel the
 * whole visit, and the group view hands back each member's own manage token
 * too - so one leaked URL is the entire party. The API redacts
 * /api/book/group/<token> from its request log; nothing here writes it
 * anywhere else.
 */

export interface GroupMemberView {
  appointmentId: string;
  /** That member's OWN token - what makes "cancel just this person" possible. */
  manageToken: string;
  position: number | null;
  firstName: string;
  status: string;
  serviceId: string;
  serviceName: string | null;
  startsAt: string;
  endsAt: string;
  priceCents: number | null;
  /** This member's time has come: their own cancel is refused, so it is not offered. */
  started?: boolean;
  /**
   * The shop's rule lets this member's own cancel go through right now
   * (config/customerChangeRules.ts). Optional = an older API (offered).
   */
  canCancel?: boolean;
}

/** The shop's rule for one change to the whole party, right now. */
export interface GroupRuleView {
  allowed: boolean;
  /** The shop's sentence when not allowed: why, and who to contact. */
  message: string | null;
}

export interface GroupView {
  status: string;
  /**
   * A request the shop has not answered yet (Request-before-booking): every
   * member is PENDING. Not cancelled, not booked - waiting.
   */
  requested?: boolean;
  /** The visit is under way: cancel-everyone and move-everyone are refused. */
  started?: boolean;
  bookedBy: string;
  shop: { slug: string; name: string; timezone: string };
  /**
   * What the shop lets this client change online right now, for the party as
   * a whole. Null = nobody still booked; optional = an older API.
   */
  rules?: { reschedule: GroupRuleView; cancel: GroupRuleView } | null;
  staff: { id: string; name: string };
  startsAt: string | null;
  endsAt: string | null;
  members: GroupMemberView[];
}

/** The shop refused a change without its own sentence (an older API). */
const GROUP_CLOSED_FALLBACK =
  "This can't be changed online right now. Please contact the shop directly.";

export async function groupViewAction(
  token: string,
): Promise<{ ok: true; group: GroupView } | { ok: false }> {
  const res = await apiPublicGet<GroupView>(
    `/api/book/group/${encodeURIComponent(token)}`,
  );
  return res.ok && res.data ? { ok: true, group: res.data } : { ok: false };
}

/** One seat whose price a move would change, as the API listed it. */
export interface GroupPriceSeat {
  appointmentId: string;
  position?: number | null;
  firstName?: string;
  fromCents: number | null;
  toCents: number;
}

/** A move that changes what the party pays: the totals and each changed seat. */
export interface GroupPriceChange {
  fromCents: number;
  toCents: number;
  seats: GroupPriceSeat[];
}

/**
 * Move the WHOLE party to a new start.
 *
 * Every member moves or none does - the API re-plans the run from the new time
 * and writes it in one transaction, so there is no state where a family is
 * told to arrive at two different times.
 */
export async function groupRescheduleAction(
  token: string,
  startsAt: string,
  /** Every changed seat's new price, exactly as a `price_changes` answer listed it. */
  acceptPrices?: GroupPriceSeat[],
): Promise<
  | { ok: true; plan: GroupPlanResult }
  | { ok: false; code: "price_changes"; priceChange: GroupPriceChange }
  | {
      ok: false;
      code:
        | "slot_taken"
        | "canceled"
        | "slot"
        | "contact_shop"
        | "price_changed"
        | "started"
        | "requested"
        | "error";
    }
  | { ok: false; code: "closed"; message: string }
> {
  const res = await apiPublicSend<{ ok: boolean; plan: GroupPlanResult }>(
    "POST",
    `/api/book/group/${encodeURIComponent(token)}/reschedule`,
    {
      startsAt,
      ...(acceptPrices !== undefined
        ? { acceptPrices: acceptPrices.map((s) => ({ appointmentId: s.appointmentId, cents: s.toCents })) }
        : {}),
    },
  );
  if (res.ok && res.data) return { ok: true, plan: res.data.plan };
  // The new time changes what someone in the party pays. NOBODY moved: the
  // page shows the new total and each changed seat, and a yes sends them back.
  if (res.error === "price_changes") {
    const body = res.body as
      | { fromCents?: number; toCents?: number; seats?: GroupPriceSeat[] }
      | undefined;
    if (body && typeof body.toCents === "number" && Array.isArray(body.seats)) {
      return {
        ok: false,
        code: "price_changes",
        priceChange: { fromCents: body.fromCents ?? 0, toCents: body.toCents, seats: body.seats },
      };
    }
    return { ok: false, code: "error" };
  }
  // Part of the party paid at booking, and the new time's price can't be
  // reconciled online: the shop moves it.
  if (res.error === "price_changed") return { ok: false, code: "price_changed" };
  // The shop arranges this booker's bookings itself; cancelling is still open.
  if (res.error === "contact_shop") return { ok: false, code: "contact_shop" };
  // The shop's rule: no moves online, or too close to the visit. Its own
  // sentence says who to contact.
  if (res.error === "reschedule_closed") {
    const body = res.body as { message?: string } | undefined;
    return { ok: false, code: "closed", message: body?.message ?? GROUP_CLOSED_FALLBACK };
  }
  if (res.error === "slot_taken" || res.error === "slot_unavailable_external") {
    return { ok: false, code: "slot_taken" };
  }
  if (res.error === "group_canceled" || res.error === "nothing_to_move") {
    return { ok: false, code: "canceled" };
  }
  // The visit has started, or the shop has not answered the request yet.
  if (res.error === "not_reschedulable") {
    return { ok: false, code: res.code === "REQUESTED" ? "requested" : "started" };
  }
  if (res.status === 400) return { ok: false, code: "slot" };
  return { ok: false, code: "error" };
}

/**
 * Cancel ONE attendee, through that member's own manage token.
 *
 * 🔴 THE ORDINARY SINGLE-APPOINTMENT CANCEL, deliberately. The rest of the
 * party stays booked, because they are still coming. Nothing infers a whole
 * -group cancel from one person dropping out, in either direction.
 */
export async function cancelMemberAction(
  memberToken: string,
): Promise<{ ok: boolean; code?: "closed"; message?: string }> {
  const res = await apiPublicSend<{ ok: boolean }>(
    "POST",
    `/api/book/manage/${encodeURIComponent(memberToken)}/cancel`,
    {},
  );
  if (!res.ok && res.error === "cancel_closed") {
    const body = res.body as { message?: string } | undefined;
    return { ok: false, code: "closed", message: body?.message ?? GROUP_CLOSED_FALLBACK };
  }
  return { ok: res.ok };
}

/**
 * Cancel the ENTIRE party. A separate, explicit action.
 *
 * Refused (`code`) once the visit has started, or while the shop has not yet
 * answered the request - the same rules a single booking's cancel follows.
 */
export async function cancelGroupAction(
  token: string,
): Promise<{
  ok: boolean;
  canceled?: number;
  code?: "started" | "requested" | "closed";
  /** `closed`: the shop's own sentence. */
  message?: string;
}> {
  const res = await apiPublicSend<{ ok: boolean; canceled: number }>(
    "POST",
    `/api/book/group/${encodeURIComponent(token)}/cancel`,
    {},
  );
  if (res.ok && res.data) return { ok: true, canceled: res.data.canceled };
  if (res.error === "not_cancelable") {
    return { ok: false, code: res.code === "REQUESTED" ? "requested" : "started" };
  }
  // The shop's rule: no cancels online, or too close to the visit.
  if (res.error === "cancel_closed") {
    const body = res.body as { message?: string } | undefined;
    return { ok: false, code: "closed", message: body?.message ?? GROUP_CLOSED_FALLBACK };
  }
  return { ok: false };
}
