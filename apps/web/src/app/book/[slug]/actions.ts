"use server";

import { apiPublicGet, apiPublicSend } from "@/lib/api";

export interface SlotsResult {
  timezone: string;
  slots: { startsAt: string; endsAt: string }[];
}

/**
 * Fetch open slots for a (staff, service) over a date range. Goes through the
 * server (CSP blocks a direct browser fetch to the API origin), same as the
 * booking submit below.
 */
export async function getSlotsAction(
  slug: string,
  staffId: string,
  serviceId: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; data?: SlotsResult; error?: string }> {
  const qs = new URLSearchParams({ staffId, serviceId, from, to }).toString();
  const res = await apiPublicGet<SlotsResult>(
    `/api/book/${encodeURIComponent(slug)}/slots?${qs}`,
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
}

/**
 * Create a native booking. Returns the manage token on success so the UI can
 * link the customer to their cancel/reschedule page. A 409 maps to a friendly
 * "that time was just taken" so the picker can refresh slots.
 */
export async function bookAction(
  slug: string,
  input: BookInput,
): Promise<{ ok: boolean; manageToken?: string; error?: string }> {
  const res = await apiPublicSend<{ ok: boolean; manageToken: string }>(
    "POST",
    `/api/book/${encodeURIComponent(slug)}`,
    input,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, manageToken: res.data.manageToken };
}
