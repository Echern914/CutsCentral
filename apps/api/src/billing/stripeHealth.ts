import type Stripe from "stripe";

/**
 * STRIPE HEALTH: what Stripe still wants from a shop's connected account, said
 * in a barber's words, and whether it is worth a banner.
 *
 * Why this exists: Stripe's requirements and payout holds were invisible
 * inside ChairBack. The Payments page showed two checkmarks; the "photo ID is
 * overdue" and "this account will be closed" warnings lived only in the
 * platform's own Stripe dashboard. Twice a barber found out only by going
 * looking for money (FadesByMikey 2026-09-02, Farrell 2026-11-19).
 *
 * PURE. connect.ts feeds it a live Stripe.Account (Payments page, webhook) and
 * mirrors `mirrorFields` onto the Shop, so the banner reads one row.
 */

export interface StripeHealth {
  /** What Stripe needs, in plain words, overdue items first. Deduped. */
  needs: string[];
  /** Something is already past Stripe's deadline (past_due non-empty). */
  overdue: boolean;
  /** Stripe's deadline for the current items (current_deadline), ISO. */
  dueBy: string | null;
  /** Stripe closed (rejected) the account. Nothing the barber sends reopens it. */
  closed: boolean;
  /** Stripe is checking something already sent (pending_verification). */
  underReview: boolean;
  /** Stripe's raw disabled_reason, kept for support. */
  disabledReason: string | null;
}

export const HEALTHY: StripeHealth = {
  needs: [],
  overdue: false,
  dueBy: null,
  closed: false,
  underReview: false,
  disabledReason: null,
};

/**
 * One Stripe requirement code in a barber's words.
 *
 * Codes look like `individual.verification.document`,
 * `person_1Abc.dob.day`, `company.tax_id` or `external_account`. The owner
 * prefix decides "your" vs "your business"; the rest decides what it is.
 * Unknown codes fall back to a generic line rather than leaking jargon.
 */
export function requirementLabel(code: string): string {
  const parts = code.split(".");
  const head = parts[0] ?? "";
  const company = head === "company";
  const rest = head === "individual" || head === "representative" || company || head.startsWith("person_")
    ? parts.slice(1)
    : parts;
  const key = rest.join(".");

  if (head === "external_account") return "Your bank account for payouts";
  if (head === "tos_acceptance") return "Accepting Stripe's terms";
  if (head === "business_type") return "Your business type";
  if (head === "business_profile") return "What your business does (a website or a short description)";
  if (["owners", "directors", "executives", "relationship"].includes(head) || key.startsWith("relationship")) {
    return "Who owns the business";
  }
  if (key.startsWith("verification.additional_document")) return "A second document that shows your address";
  if (key.startsWith("verification.document") || key === "verification") {
    return company ? "A business document" : "A photo of your ID";
  }
  if (key === "tax_id" || key.startsWith("tax_id")) return "Your business tax ID (EIN)";
  if (key === "id_number" || key === "ssn_last_4") return "Your Social Security number";
  if (key.startsWith("dob")) return "Your date of birth";
  if (key.startsWith("address")) return company ? "Your business address" : "Your home address";
  if (["first_name", "last_name", "name"].includes(key)) return company ? "Your business's legal name" : "Your legal name";
  if (key === "email") return "Your email";
  if (key === "phone") return company ? "Your business phone number" : "Your phone number";
  return "Other details Stripe asks for";
}

type AccountLike = Pick<Stripe.Account, "requirements">;

/** What Stripe wants from this account right now. PURE. */
export function summarizeStripeHealth(acct: AccountLike): StripeHealth {
  const r = acct.requirements;
  if (!r) return HEALTHY;
  const pastDue = r.past_due ?? [];
  const current = r.currently_due ?? [];
  const needs: string[] = [];
  // Overdue first: it is what has already stopped (or is about to stop) money.
  for (const code of [...pastDue, ...current]) {
    const label = requirementLabel(code);
    if (!needs.includes(label)) needs.push(label);
  }
  const disabledReason = r.disabled_reason ?? null;
  return {
    needs,
    overdue: pastDue.length > 0,
    dueBy: r.current_deadline ? new Date(r.current_deadline * 1000).toISOString() : null,
    closed: Boolean(disabledReason?.startsWith("rejected")),
    underReview: (r.pending_verification ?? []).length > 0,
    disabledReason,
  };
}

/** The Shop columns that mirror a health summary (see schema: connectRequirements*). */
export function mirrorFields(h: StripeHealth): {
  connectRequirementsDue: boolean;
  connectRequirementsDueBy: Date | null;
  connectDisabledReason: string | null;
} {
  return {
    connectRequirementsDue: h.needs.length > 0,
    connectRequirementsDueBy: h.dueBy ? new Date(h.dueBy) : null,
    connectDisabledReason: h.disabledReason,
  };
}

/** The same columns, emptied (no account, or one we were disconnected from). */
export const CLEARED_MIRROR = {
  connectRequirementsDue: false,
  connectRequirementsDueBy: null,
  connectDisabledReason: null,
} as const;

export type StripeAlert =
  | { kind: "closed" }
  | { kind: "payments_paused" }
  | { kind: "payouts_paused" }
  | { kind: "details_due"; dueBy: string };

/**
 * Whether the dashboard should carry a Stripe banner, from the mirrored Shop
 * columns alone. PURE.
 *
 * 🔴 A shop that never took a card payment gets NO banner for a paused or
 * closed account. Plenty of shops started Stripe setup and walked away; their
 * account is "paused" only in the sense that it never began, and the Payments
 * page already explains that. A banner on every page would nag shops that
 * never wanted card payments. Once money has moved, a pause is real news.
 */
export function stripeAlertFor(f: {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: boolean;
  dueBy: Date | null;
  disabledReason: string | null;
  hasTakenPayments: boolean;
  now?: Date;
}): StripeAlert | null {
  if (!f.connected) return null;
  if (f.disabledReason?.startsWith("rejected")) return f.hasTakenPayments ? { kind: "closed" } : null;
  if (!f.chargesEnabled) return f.hasTakenPayments ? { kind: "payments_paused" } : null;
  if (!f.payoutsEnabled) return { kind: "payouts_paused" };
  // 🔴 ONLY A DEADLINE STILL AHEAD. Stripe pauses card payments or payouts
  // the moment an overdue item is one they need - so an item overdue while
  // both still run is NOT stopping money (2026-11-19: a photo ID "past due"
  // that only affected Affirm). A banner saying "Stripe may pause your
  // payments" over that is a false alarm; the Payments page lists it.
  // Likewise an item with no deadline is not urgent.
  const now = f.now ?? new Date();
  if (f.requirementsDue && f.dueBy && f.dueBy.getTime() > now.getTime()) {
    return { kind: "details_due", dueBy: f.dueBy.toISOString() };
  }
  return null;
}
