/**
 * THE SUPPORT ENGINE — one brain, many adapters.
 *
 * Every support surface resolves a question through `resolveSupport()`: the
 * Assistant tab, the help bubble, and (PR 2) the MCP connector. Intent
 * resolution, actor permissions, the knowledge it may draw on, and the
 * never-a-dead-end contract live HERE, once. Adapters decide only how to
 * render the result.
 *
 * ── 🔴 THE CONTRACT ─────────────────────────────────────────────────────────
 *
 * A resolution is never a shrug. Exactly one of these is always true:
 *
 *   ANSWERED                 — we lead with an answer.
 *   NEEDS_ONE_CLARIFICATION  — one focused question unlocks it, and we still
 *                              carry the closest topics AND the way to a human.
 *   ESCALATION_REQUIRED      — we cannot answer, so we say so plainly and hand
 *                              over a route to a human plus a summary they do
 *                              not have to retype.
 *   UNSUPPORTED              — genuinely outside what ChairBack does, or not
 *                              this actor's to ask. Said plainly, without
 *                              confirming anything about what exists.
 *
 * `escalation` is NON-NULL for every outcome except ANSWERED. That single
 * invariant is what removes the product's one dead end: the Assistant tab's
 * ask field used to offer chips and no way to reach a person.
 *
 * ── 🔴 WHAT THIS FILE MAY NOT DO ────────────────────────────────────────────
 *
 * No I/O. No model. No network. No clock. It is a pure function of (question,
 * actor, seat, facts-the-caller-already-had), which is what lets the in-app
 * assistant keep answering from the bundle at zero cost — the property
 * `costBoundary.test.ts` exists to defend — and lets the whole thing be
 * evaluated exactly rather than statistically.
 *
 * Live data enters ONLY as `facts`, resolved by the caller on the server. The
 * engine never fetches; it decides what it would need and says so.
 */

import { resolveFeature, type NavContext, type SeatRole } from "./features.js";
import type { HelpAnswer } from "./help.js";
import { findHelp, helpAnswerById } from "./helpMatch.js";
import {
  capabilityForCorpusId,
  SUPPORT_ESCALATION_EMAIL,
  type KnowledgeAuthority,
  type SupportActor,
  type SupportCapability,
} from "./supportCapabilities.js";

export type { KnowledgeAuthority, SupportActor };

/* ================================ vocabulary ============================== */

/**
 * What a support interaction resolves to.
 *
 * The full vocabulary is declared here even though this engine can only
 * produce four of them today, because the three action outcomes are the
 * contract PR 3 has to satisfy: an action is either completed and VERIFIED,
 * or it is waiting on an explicit confirmation. Declaring them now means a
 * later action path has a named outcome to return rather than an excuse to
 * flatten a half-finished mutation into "ANSWERED".
 */
export const SUPPORT_OUTCOMES = [
  /** A direct answer, from an authoritative source. */
  "ANSWERED",
  /** An authorized action was performed AND its result verified. (PR 3) */
  "ACTION_COMPLETED",
  /** An action is ready but needs explicit confirmation first. (PR 3) */
  "ACTION_REQUIRES_CONFIRMATION",
  /** One focused question back to the asker unlocks the answer. */
  "NEEDS_ONE_CLARIFICATION",
  /** The capability exists but a dependency is down. (PR 3) */
  "TEMPORARILY_UNAVAILABLE",
  /** A human must take over; a precise handoff was produced. */
  "ESCALATION_REQUIRED",
  /** Genuinely outside what ChairBack supports, or not this actor's to ask. */
  "UNSUPPORTED",
] as const;

export type SupportOutcome = (typeof SUPPORT_OUTCOMES)[number];

/** The subset `resolveSupport` can return today. Widening this is a PR 3 act. */
export type KnowledgeOutcome = Extract<
  SupportOutcome,
  "ANSWERED" | "NEEDS_ONE_CLARIFICATION" | "ESCALATION_REQUIRED" | "UNSUPPORTED"
>;

export type SupportChannel = "in_app" | "mcp";

export interface SupportSource {
  authority: KnowledgeAuthority;
  /** Corpus entry id, capability id, or fact key — enough to trace an answer. */
  id: string;
}

/**
 * Live facts the CALLER already resolved, server-side. Optional by design: an
 * answer that needs one and does not get it degrades to a written answer plus
 * a pointer, never to a wrong answer or a shrug.
 */
export interface SupportFacts {
  /** Prose form of this shop's cancellation/deposit policy. */
  policySentence?: string;
  /** The shop's public booking URL. */
  bookingUrl?: string;
  /** Prose form of the shop's opening hours. */
  hoursSentence?: string;
}

export interface SupportSeat {
  role: SeatRole;
  /** Inside the iOS/Android shell — drops price-quoting copy (App Store 3.1.1). */
  inApp?: boolean;
  hasAccess?: boolean;
  flagsOff?: readonly NonNullable<NavContext["flagsOff"]>[number][];
  demo?: boolean;
  hasPremiumAi?: boolean;
}

export interface SupportRequest {
  question: string;
  actor: SupportActor;
  channel: SupportChannel;
  /** Present for authenticated seats; absent for a public customer. */
  seat?: SupportSeat;
  facts?: SupportFacts;
}

export interface SupportAnswer {
  id: string;
  question: string;
  body: string;
  /** Resolved against THIS seat, or null when the destination is withheld. */
  action: { label: string; featureId: string; href: string } | null;
}

export interface SupportEscalation {
  /** The one channel that exists. */
  email: string;
  /**
   * A short summary the person can send as-is. It quotes the question back
   * because retyping the problem is the tax every support flow charges.
   */
  summary: string;
}

export interface SupportResolution {
  outcome: KnowledgeOutcome;
  /** Non-null exactly when outcome is ANSWERED. */
  answer: SupportAnswer | null;
  /** The closest topics. Never empty except on an UNSUPPORTED refusal. */
  suggestions: readonly { id: string; question: string }[];
  /** 🔴 Non-null for every outcome EXCEPT ANSWERED. The no-dead-end rule. */
  escalation: SupportEscalation | null;
  /** What the engine believes was being asked, when it could tell. */
  capabilityId: string | null;
  /** Traceability: what grounded this. Empty on a refusal. */
  sources: readonly SupportSource[];
  /**
   * Set when the answer would be materially better with a live fact the caller
   * did not supply. Adapters may use it to decide what to fetch next; it is
   * never shown to a user.
   */
  wantedFact?: keyof SupportFacts;
}

/* ============================== actor mapping ============================= */

const SEAT_OF: Partial<Record<SupportActor, SeatRole>> = {
  barber: "BARBER",
  manager: "MANAGER",
  owner: "OWNER",
};

/**
 * The actor a signed-in seat asks as.
 *
 * Adapters must not hand-roll this: a seat mapped one way in the bubble and
 * another in the Assistant tab is exactly how two surfaces start enforcing
 * two different permission rules over one corpus.
 */
export function actorForSeat(role: SeatRole): SupportActor {
  return role === "OWNER" ? "owner" : role === "MANAGER" ? "manager" : "barber";
}

/** The seat an actor resolves destinations against. */
function seatContext(req: SupportRequest): NavContext {
  const fromActor = SEAT_OF[req.actor];
  const seat = req.seat;
  return {
    role: seat?.role ?? fromActor ?? "OWNER",
    inApp: seat?.inApp ?? false,
    hasAccess: seat?.hasAccess ?? true,
    hasPremiumAi: seat?.hasPremiumAi,
    demo: seat?.demo,
    flagsOff: seat?.flagsOff ? [...seat.flagsOff] : [],
  };
}

/**
 * May this actor be handed this answer?
 *
 * A capability with no actor list is unrestricted product knowledge. One WITH
 * a list is gated: a customer asking a question the corpus answers for owners
 * ("how do I resend a rewards link") must not be handed staff instructions,
 * because the copy assumes a dashboard they cannot open.
 */
function actorMayReceive(cap: SupportCapability | undefined, actor: SupportActor): boolean {
  if (!cap) return true;
  if (cap.actors.length === 0) return false; // must-refuse capability
  return cap.actors.includes(actor);
}

/* ================================ the API ================================= */

/** Trim a question down to something safe and short enough to quote back. */
function summarize(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

function escalationFor(question: string): SupportEscalation {
  return {
    email: SUPPORT_ESCALATION_EMAIL,
    summary: `Question we could not answer in the app: "${summarize(question)}"`,
  };
}

function toAnswer(entry: HelpAnswer, ctx: NavContext, facts: SupportFacts): SupportAnswer {
  const resolved = entry.action ? resolveFeature(entry.action.featureId, ctx) : null;
  return {
    id: entry.id,
    question: entry.q,
    // A live fact always beats written copy about the same thing (see the
    // authority ranking): when the caller supplied one, it leads.
    body: applyFacts(entry, facts),
    action:
      entry.action && resolved?.ok
        ? {
            label: entry.action.label,
            featureId: entry.action.featureId,
            href: resolved.href,
          }
        : null,
  };
}

/**
 * Fold a live fact into a written answer.
 *
 * The written body explains the mechanism; the fact states THIS shop's value.
 * Both matter, so the fact leads and the explanation follows — a shop owner
 * asking "what is my cancellation policy" wants the number first.
 */
function applyFacts(entry: HelpAnswer, facts: SupportFacts): string {
  const fact = FACT_FOR_ENTRY[entry.id];
  const value = fact ? facts[fact] : undefined;
  return value ? `${value}\n\n${entry.a}` : entry.a;
}

/** Which written answers are improved by which live fact. */
const FACT_FOR_ENTRY: Record<string, keyof SupportFacts> = {
  "my-policy": "policySentence",
  "booking-link": "bookingUrl",
  "set-hours": "hoursSentence",
};

const MAX_SUGGESTIONS = 4;

/**
 * Resolve one support question. Pure; see the contract at the top of the file.
 */
export function resolveSupport(req: SupportRequest): SupportResolution {
  const ctx = seatContext(req);
  const facts = req.facts ?? {};
  const found = findHelp(req.question, { inApp: ctx.inApp === true });

  const suggestions = found.suggestions
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({ id: s.id, question: s.q }));

  if (found.kind === "answer" && found.answer) {
    const cap = capabilityForCorpusId(found.answer.id);
    if (actorMayReceive(cap, req.actor)) {
      const answer = toAnswer(found.answer, ctx, facts);
      const wanted = FACT_FOR_ENTRY[found.answer.id];
      const sources: SupportSource[] = [
        { authority: "help_corpus", id: found.answer.id },
      ];
      if (wanted && facts[wanted]) {
        // The live value led the body, so record it as the stronger source.
        sources.unshift({ authority: "live_state", id: wanted });
      }
      if (cap) sources.push({ authority: "app_config", id: cap.id });
      return {
        outcome: "ANSWERED",
        answer,
        suggestions,
        escalation: null,
        capabilityId: cap?.id ?? null,
        sources,
        ...(wanted && !facts[wanted] ? { wantedFact: wanted } : {}),
      };
    }
    // The corpus knows this, but not for this asker. Refuse the ANSWER, not
    // the person: they still get the closest topics and a route to a human.
    return {
      outcome: "UNSUPPORTED",
      answer: null,
      suggestions,
      escalation: escalationFor(req.question),
      capabilityId: cap?.id ?? null,
      sources: [],
    };
  }

  // Not confident. The suggestions ARE the useful part, so this is a
  // clarification, not a failure — but it carries the way out either way.
  return {
    outcome: suggestions.length > 0 ? "NEEDS_ONE_CLARIFICATION" : "ESCALATION_REQUIRED",
    answer: null,
    suggestions,
    escalation: escalationFor(req.question),
    capabilityId: null,
    sources: [],
  };
}

/**
 * Resolve a suggestion the user tapped, by corpus id.
 *
 * Adapters used to re-run the matcher over the suggestion's question text,
 * which works only because the corpus guarantees a canonical question resolves
 * to itself. Going by id is exact, and it is the same call PR 2 exposes over
 * MCP so a host model can finally redeem a suggestion instead of dead-ending.
 */
export function resolveSupportAnswerById(
  id: string,
  req: Omit<SupportRequest, "question">,
): SupportResolution {
  const entry = helpAnswerById(id);
  const ctx = seatContext(req as SupportRequest);
  if (!entry) {
    return {
      outcome: "ESCALATION_REQUIRED",
      answer: null,
      suggestions: [],
      escalation: escalationFor(`help topic "${id}"`),
      capabilityId: null,
      sources: [],
    };
  }
  const cap = capabilityForCorpusId(entry.id);
  if (!actorMayReceive(cap, req.actor)) {
    return {
      outcome: "UNSUPPORTED",
      answer: null,
      suggestions: [],
      escalation: escalationFor(entry.q),
      capabilityId: cap?.id ?? null,
      sources: [],
    };
  }
  return {
    outcome: "ANSWERED",
    answer: toAnswer(entry, ctx, req.facts ?? {}),
    suggestions: [],
    escalation: null,
    capabilityId: cap?.id ?? null,
    sources: [{ authority: "help_corpus", id: entry.id }],
  };
}
