"use server";

import { apiPublicSend } from "@/lib/api";

export interface RequestInput {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  preferredTime?: string;
  message?: string;
}

/**
 * Submit an appointment request from the public shop page. POSTs to the public
 * API via the server (the CSP blocks a direct browser fetch). The lead lands in
 * the barber's dashboard and texts them if they've set a notify number.
 */
export async function submitRequestAction(
  slug: string,
  input: RequestInput,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiPublicSend(
    "POST",
    `/api/page/${encodeURIComponent(slug)}/request`,
    input,
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true };
}
