/**
 * The support-outcome taxonomy — the shared vocabulary for what happened when
 * someone asked ChairBack for help.
 *
 * Two enums live here and they must not be conflated:
 *
 * - `SupportOutcome` is the TARGET taxonomy: what a support interaction should
 *   resolve to once the shared support engine exists (PR 1+). It is the
 *   contract future pipeline code and the quality ledger will speak.
 * - `ObservedBehavior` is the MEASUREMENT taxonomy: what the CURRENT surfaces
 *   actually did with a question, as classified by the deterministic eval
 *   harness. It exists so the baseline can be honest about today — including
 *   the failure modes the target taxonomy is designed to eliminate.
 *
 * 🔴 Nothing in this file is imported by runtime code yet. PR 0 defines the
 * vocabulary and measures with it; no customer-visible behavior changes.
 */

/**
 * What a support interaction resolves to. One of these, always — flattening
 * every failure into "I don't know" is the exact behavior this arc removes.
 */
export const SUPPORT_OUTCOMES = [
  /** A direct answer was given from an authoritative source. */
  "ANSWERED",
  /** An authorized action was performed and its result verified. */
  "ACTION_COMPLETED",
  /** An action is ready but needs the user's explicit confirmation first. */
  "ACTION_REQUIRES_CONFIRMATION",
  /** One focused question back to the user unlocks the answer. */
  "NEEDS_ONE_CLARIFICATION",
  /** The capability exists but a dependency is down; retry guidance given. */
  "TEMPORARILY_UNAVAILABLE",
  /** A human must take over; a precise handoff was produced. */
  "ESCALATION_REQUIRED",
  /** Genuinely outside what ChairBack supports; said so plainly. */
  "UNSUPPORTED",
] as const;

export type SupportOutcome = (typeof SUPPORT_OUTCOMES)[number];

/**
 * What the CURRENT system was observed to do with one question on one channel.
 * Ordered roughly best → worst; `wrong_answer` sorts below `shrug` on purpose:
 * a confidently wrong answer is the most expensive thing a help surface can
 * produce, because the user acts on it (see helpMatch.ts's CONFIDENCE note —
 * the design knew this; the corpus drifted out from under it).
 */
export const OBSERVED_BEHAVIORS = [
  /** Confident answer whose corpus id is in the fixture's accepted set. */
  "correct_answer",
  /** No confident answer, but an accepted id appears among the suggestions. */
  "near_miss",
  /** No confident answer and no accepted id among the suggestions. */
  "shrug",
  /** Scored zero everywhere: the hard-coded fallback topic menu. */
  "generic_menu",
  /** Confident answer whose id is NOT accepted for this question. */
  "wrong_answer",
] as const;

export type ObservedBehavior = (typeof OBSERVED_BEHAVIORS)[number];

/** Who is asking. The support system must never treat these as one actor. */
export const SUPPORT_ACTORS = [
  /** Anyone on the public internet. No identity at all. */
  "public_customer",
  /**
   * A customer holding a live scoped credential: an appointment manageToken,
   * a rewards magic link, a waitlist offer/cancel token, or a walk-in track
   * token. Identity extends exactly as far as that credential's scope.
   */
  "verified_customer",
  /** BARBER seat: own chair only, never the shop's book. */
  "barber",
  /** MANAGER seat: shop-wide reads and day-to-day writes. */
  "manager",
  /** OWNER seat: everything a manager has plus billing and destruction. */
  "owner",
  /** Cross-shop ChairBack operator. Out of scope for shop support surfaces. */
  "platform_admin",
  /**
   * An external AI (Claude/ChatGPT) holding an OAuth token minted for a seat.
   * Effective rights are ALWAYS the intersection of the seat's role and the
   * token's scopes — never more than the human who connected it.
   */
  "mcp_user",
] as const;

export type SupportActor = (typeof SUPPORT_ACTORS)[number];

/** The surfaces a question can arrive on. */
export const SUPPORT_CHANNELS = ["in_app", "mcp"] as const;
export type SupportChannel = (typeof SUPPORT_CHANNELS)[number];

/**
 * How authoritative a knowledge source is. Lower rank wins a conflict; model
 * general knowledge must never override live ChairBack data.
 */
export const KNOWLEDGE_AUTHORITIES = [
  /** 1 — live database or provider state, read at answer time. */
  "live_state",
  /** 2 — current application policy/configuration (env, PLANS, registry). */
  "app_config",
  /** 3 — canonical ChairBack help content (help.ts corpus). */
  "help_corpus",
  /** 4 — static explanatory content (marketing/support pages, docs). */
  "static_content",
  /** 5 — model general knowledge. Never authoritative for ChairBack facts. */
  "model_general",
] as const;

export type KnowledgeAuthority = (typeof KNOWLEDGE_AUTHORITIES)[number];
