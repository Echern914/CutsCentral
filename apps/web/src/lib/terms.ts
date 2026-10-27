import { apiGet } from "./api";

/**
 * Where this person stands on the Terms of Service + Privacy Policy, as
 * GET /api/auth/terms answers it. The API decides `required` (it holds the
 * version it stamps), so the web never compares versions itself.
 */
export interface TermsStatus {
  required: boolean;
  currentVersion: string;
  /** null = never agreed on record (Google/Apple signup, accounts from before). */
  acceptedVersion: string | null;
}

/**
 * The read behind the dashboard's "Before you continue" screen. FAILS OPEN,
 * always: an older API without the route (404), a network blip, a 5xx or a
 * malformed answer all return null, and null never shows the gate. A missed
 * prompt costs a nuisance; a barber locked out of their dashboard mid-day,
 * with clients in the chair, is real harm. Server-only (forwards the cookie).
 */
export async function getTermsStatus(): Promise<TermsStatus | null> {
  try {
    const res = await apiGet<Partial<TermsStatus>>("/api/auth/terms");
    const d = res.ok ? res.data : null;
    if (!d || typeof d.required !== "boolean" || typeof d.currentVersion !== "string") return null;
    return {
      required: d.required,
      currentVersion: d.currentVersion,
      acceptedVersion: typeof d.acceptedVersion === "string" ? d.acceptedVersion : null,
    };
  } catch {
    return null;
  }
}

/**
 * Does the dashboard show the gate instead of itself? Only on a definite
 * "required" from the API, and never for the read-only demo (one shared
 * account, which cannot write the answer anyway). Unknown = no gate.
 */
export function termsGateShows(status: TermsStatus | null, opts: { demo: boolean }): boolean {
  if (opts.demo) return false;
  return status?.required === true;
}
