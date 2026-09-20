"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";

/**
 * Server actions for booking a party of 2-3, back to back with one barber.
 *
 * 🔴 THE BROWSER NEVER SUPPLIES A DURATION, A PRICE OR A TOTAL. Every one of
 * these passes service IDs and gets the arithmetic back from the API, which
 * resolves it from the shop's own rows. What the page renders is the server's
 * answer, verbatim - so a tampered client can misdescribe nothing, and a stale
 * tab cannot quote yesterday's price.
 *
 * Same shape as the single booking page's actions.ts: the browser talks to
 * these, these talk to the API. Nothing here reimplements booking logic. It
 * also has to be this way - the CSP (connect-src 'self') blocks a direct
 * browser fetch to the API origin.
 */

export interface GroupMember {
  position: number;
  firstName: string;
  serviceId: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  priceCents: number | null;
}

export interface GroupPlanResult {
  startsAt: string;
  endsAt: string;
  totalDurationMin: number;
  totalPriceCents: number;
  /** Services with no price set. The total must not pretend these are free. */
  unpricedCount: number;
  members: GroupMember[];
}

export interface GroupSlotsResult {
  timezone: string;
  totalDurationMin: number;
  slots: { startsAt: string; endsAt: string }[];
}

/** One attendee, as the customer typed them. */
export interface GroupAttendeeInput {
  firstName: string;
  serviceId: string;
}

/**
 * Start times that fit the WHOLE party - not times sized for one haircut.
 *
 * 🔴 serviceIds go in ATTENDEE ORDER and repeats are kept. Two siblings can
 * want the same cut, and that duration has to count twice; the API refuses to
 * deduplicate for exactly that reason.
 */
export async function groupSlotsAction(
  slug: string,
  input: { staffId: string; serviceIds: string[]; from: string; to: string },
): Promise<
  | { ok: true; data: GroupSlotsResult }
  | { ok: false; code: "unavailable" | "payments" | "error" }
> {
  const qs = new URLSearchParams({
    staffId: input.staffId,
    serviceIds: input.serviceIds.join(","),
    from: input.from,
    to: input.to,
  }).toString();
  const res = await apiPublicGet<GroupSlotsResult>(
    `/api/book/${encodeURIComponent(slug)}/group/slots?${qs}`,
  );
  if (res.ok && res.data) return { ok: true, data: res.data };
  if (res.error === "group_payments_unsupported") return { ok: false, code: "payments" };
  if (res.status === 403 || res.status === 404) return { ok: false, code: "unavailable" };
  return { ok: false, code: "error" };
}

/**
 * The sequence and the total, computed by the server, booking nothing.
 *
 * This is what the customer confirms against. Rendering a locally-computed
 * sequence would be a second implementation of the shop's duration and price
 * rules, free to disagree with the one that actually writes the appointments.
 */
export async function groupPlanAction(
  slug: string,
  input: { staffId: string; startsAt: string; attendees: GroupAttendeeInput[] },
): Promise<
  | { ok: true; plan: GroupPlanResult }
  | { ok: false; code: "payments" | "slot" | "service_hours" | "error" }
> {
  const res = await apiPublicSend<{ plan: GroupPlanResult }>(
    "POST",
    `/api/book/${encodeURIComponent(slug)}/group/plan`,
    input,
  );
  if (res.ok && res.data) return { ok: true, plan: res.data.plan };
  if (res.error === "group_payments_unsupported") return { ok: false, code: "payments" };
  if (res.error === "service_not_offered_then") return { ok: false, code: "service_hours" };
  if (res.status === 400) return { ok: false, code: "slot" };
  return { ok: false, code: "error" };
}

/** Every distinguishable outcome of trying to book a party. */
export type GroupCreateOutcome =
  | { kind: "booked"; groupId: string; manageToken: string }
  /** The chairs are held; the calendar mirror has not answered yet. */
  | { kind: "confirming"; groupId: string; manageToken: string }
  | { kind: "slot_taken" }
  | { kind: "payments" }
  | { kind: "invalid" }
  /** The request never completed. SAFE TO RETRY with the same key. */
  | { kind: "network" }
  | { kind: "error" };

export interface GroupCreateInput {
  staffId: string;
  startsAt: string;
  attendees: GroupAttendeeInput[];
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  smsConsent?: boolean;
  /**
   * 🔴 GENERATED ONCE PER ATTEMPT AND REUSED ON EVERY RETRY. A group create is
   * several appointments in one transaction; a retry of a request whose
   * response never arrived must return the SAME party, not a second set of
   * chairs. The API keys a unique index on this.
   */
  idempotencyKey: string;
}

/**
 * Book the party.
 *
 * 🔴 202 IS NOT A FAILURE. It means the appointments exist and the chairs are
 * held, but the barber's external calendar has not confirmed the block yet. The
 * customer keeps their booking; a background sweep finishes it. Telling them it
 * failed would be false, and telling them it succeeded would promise a time not
 * yet proven protected - so it gets its own outcome and its own screen.
 */
export async function groupCreateAction(
  slug: string,
  input: GroupCreateInput,
): Promise<GroupCreateOutcome> {
  let res;
  try {
    res = await apiPublicSend<{ groupId: string; manageToken: string; status?: string }>(
      "POST",
      `/api/book/${encodeURIComponent(slug)}/group`,
      input,
    );
  } catch {
    // The request did not complete. The party may or may not exist - which is
    // precisely what the idempotency key is for on the retry.
    return { kind: "network" };
  }
  if (res.ok && res.data) {
    // 202 carries status:"processing"; 200 (idempotent replay) and 201 do not.
    if (res.data.status === "processing") {
      return {
        kind: "confirming",
        groupId: res.data.groupId,
        manageToken: res.data.manageToken,
      };
    }
    return { kind: "booked", groupId: res.data.groupId, manageToken: res.data.manageToken };
  }
  if (res.error === "group_payments_unsupported") return { kind: "payments" };
  if (res.error === "slot_taken" || res.error === "slot_unavailable_external") {
    return { kind: "slot_taken" };
  }
  if (res.status === 400 || res.status === 422) return { kind: "invalid" };
  return { kind: "error" };
}
