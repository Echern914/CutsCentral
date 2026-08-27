"use server";

import { apiGet, apiSend } from "@/lib/api";
import type { WalkInEntryRow } from "../booking/actions";

/**
 * The barber seat's walk-in actions. Everything lands on /api/barber/walk-ins,
 * where the chair is ALWAYS the seat's own (req.shopStaffId) - these actions
 * carry ids and verbs, never a staffId.
 */

export interface BarberWalkInsData {
  chairStaffId: string | null;
  acceptingNow: boolean;
  now: string;
  entries: WalkInEntryRow[];
}

export async function getBarberWalkInsAction(): Promise<{
  ok: boolean;
  data?: BarberWalkInsData;
  /** "walk_in_disabled" and 404 are NORMAL answers (shop off / feature dark)
   *  - the section simply doesn't render. */
  error?: string;
  status?: number;
}> {
  const res = await apiGet<BarberWalkInsData>("/api/barber/walk-ins");
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error ?? "failed", status: res.status };
  }
  return { ok: true, data: res.data };
}

export type BarberWalkInVerb =
  | "claim"
  | "ready"
  | "return"
  | "no-show"
  | "start"
  | "complete";

export async function barberWalkInAction(
  id: string,
  verb: BarberWalkInVerb,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/barber/walk-ins/${id}/${verb}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}
