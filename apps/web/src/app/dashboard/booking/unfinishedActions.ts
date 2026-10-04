"use server";

import { apiGet, apiSend } from "@/lib/api";

/**
 * "Didn't finish booking": the server actions behind UnfinishedBookings.
 *
 * Its own module, like conflictActions.ts, so the calendar tests that mock
 * `./actions` export by export never need to learn about it. Booking a person
 * from the list goes through the ordinary createAppointmentAction.
 */

export type UnfinishedReason =
  | "card_not_saved"
  | "card_saved_late"
  | "not_paid"
  | "paid_late_refunded"
  | "paid_late"
  | "not_finished";

export interface UnfinishedRow {
  /** The appointment row of their latest try. */
  id: string;
  clientId: string | null;
  /** What this person typed. */
  firstName: string;
  lastName: string | null;
  /** E.164, for the Text and Call links. */
  phone: string | null;
  /** The same number for a person to read. */
  phoneDisplay: string | null;
  email: string | null;
  /** False once they texted STOP. Calling is unaffected. */
  canText: boolean;
  /**
   * Someone else's client profile, reached through a shared phone or email.
   * Booking them here would put it under that name (and that person's saved
   * card), so the list doesn't offer it.
   */
  profileName: string | null;
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
  addOns: { id: string; name: string }[];
  startsAt: string;
  endsAt: string;
  triedAt: string;
  attempts: number;
  /** live = on the card step right now; lapsed = the hold ran out. */
  state: "live" | "lapsed";
  heldUntil: string | null;
  /** A hold at that time ran out moments ago and isn't released yet: bookable in a few minutes. */
  releasing: boolean;
  timeTaken: boolean;
  /** Blocked on the shop's other calendar, with nobody in it. */
  blockedElsewhere: boolean;
  reason: UnfinishedReason | null;
  /** They tried for one of the shop's specials. */
  wantedSpecial: boolean;
  /** That special, still on offer: book it as that special. */
  targetedSlotId: string | null;
  repeating: boolean;
  otherTimes: { startsAt: string; serviceName: string }[];
}

export interface UnfinishedList {
  timezone: string;
  more: number;
  rows: UnfinishedRow[];
}

export async function listUnfinishedAction(): Promise<{ ok: boolean; data?: UnfinishedList; error?: string }> {
  const res = await apiGet<UnfinishedList>("/api/booking/unfinished");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

/** Take a person off the list. Changes no booking. */
export async function dismissUnfinishedAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend<{ ok: boolean }>(
    "POST",
    `/api/booking/unfinished/${encodeURIComponent(id)}/dismiss`,
    {},
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}
