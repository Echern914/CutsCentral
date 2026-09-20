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
}

export interface GroupView {
  status: string;
  bookedBy: string;
  shop: { slug: string; name: string; timezone: string };
  staff: { id: string; name: string };
  startsAt: string | null;
  endsAt: string | null;
  members: GroupMemberView[];
}

export async function groupViewAction(
  token: string,
): Promise<{ ok: true; group: GroupView } | { ok: false }> {
  const res = await apiPublicGet<GroupView>(
    `/api/book/group/${encodeURIComponent(token)}`,
  );
  return res.ok && res.data ? { ok: true, group: res.data } : { ok: false };
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
): Promise<
  | { ok: true; plan: GroupPlanResult }
  | { ok: false; code: "slot_taken" | "canceled" | "slot" | "error" }
> {
  const res = await apiPublicSend<{ ok: boolean; plan: GroupPlanResult }>(
    "POST",
    `/api/book/group/${encodeURIComponent(token)}/reschedule`,
    { startsAt },
  );
  if (res.ok && res.data) return { ok: true, plan: res.data.plan };
  if (res.error === "slot_taken" || res.error === "slot_unavailable_external") {
    return { ok: false, code: "slot_taken" };
  }
  if (res.error === "group_canceled" || res.error === "nothing_to_move") {
    return { ok: false, code: "canceled" };
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
): Promise<{ ok: boolean }> {
  const res = await apiPublicSend<{ ok: boolean }>(
    "POST",
    `/api/book/manage/${encodeURIComponent(memberToken)}/cancel`,
    {},
  );
  return { ok: res.ok };
}

/** Cancel the ENTIRE party. A separate, explicit action. */
export async function cancelGroupAction(
  token: string,
): Promise<{ ok: boolean; canceled?: number }> {
  const res = await apiPublicSend<{ ok: boolean; canceled: number }>(
    "POST",
    `/api/book/group/${encodeURIComponent(token)}/cancel`,
    {},
  );
  return res.ok && res.data
    ? { ok: true, canceled: res.data.canceled }
    : { ok: false };
}
