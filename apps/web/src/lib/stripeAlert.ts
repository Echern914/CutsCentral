import { apiGet } from "./api";

/**
 * Whether the dashboard should warn about the shop's Stripe account, as
 * GET /api/payments/stripe-alert answers it (apps/api billing/stripeHealth.ts
 * stripeAlertFor, read from the Shop's mirrored columns, never Stripe).
 */
export type StripeAlert =
  | { kind: "closed" }
  | { kind: "payments_paused" }
  | { kind: "payouts_paused" }
  | { kind: "details_due"; dueBy: string };

const KINDS = new Set(["closed", "payments_paused", "payouts_paused", "details_due"]);

/**
 * FAILS QUIET, always: an older API (404), an employee seat (403), a locked
 * shop, a blip or a malformed answer all mean "no banner", never a broken
 * dashboard. Server-only (it forwards the session cookie).
 */
export async function getStripeAlert(): Promise<StripeAlert | null> {
  try {
    const res = await apiGet<{ alert?: StripeAlert | null }>("/api/payments/stripe-alert");
    const alert = res.ok ? res.data?.alert : null;
    return alert && typeof alert === "object" && KINDS.has(alert.kind) ? alert : null;
  } catch {
    return null;
  }
}
