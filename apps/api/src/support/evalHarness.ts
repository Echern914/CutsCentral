/**
 * The deterministic support-evaluation harness.
 *
 * It measures the two support channels by driving the SAME code production
 * runs — no model, no network, no database:
 *
 * - `in_app`: `resolveSupport()` from @chairback/config — the shared support
 *   engine both in-app surfaces now call. PR 0 measured `findHelp()` directly,
 *   which was right when that WAS the whole answer path; measuring the raw
 *   matcher now would score something users never see, and would miss the two
 *   things PR 1 added on top of it: actor gating and the guarantee that a
 *   non-answer still carries a route to a human.
 * - `mcp`: the real `help_find_feature` tool handler out of TOOL_DEFINITIONS,
 *   invoked exactly as the dispatcher would after auth (the handler touches no
 *   shop data, so a synthetic invocation is byte-for-byte what the wire runs).
 *
 * Determinism is structural: both paths are pure functions of their input, so
 * the baseline in `supportEvalBaseline.ts` is exact, not statistical.
 *
 * Live-data capabilities are additionally assessed at the CONTRACT level:
 * does an MCP tool bound to the capability exist and is it reachable for the
 * actor per the real policy table? That measures tool coverage without
 * pretending to know which tool an external model would pick.
 */

import { READ_SCOPES } from "@chairback/config";
import { resolveSupport, type SupportActor } from "@chairback/config";
import { decideTool } from "../mcp/toolPolicy.js";
import { toolDefinition } from "../mcp/tools/index.js";
import {
  capabilityById,
  SUPPORT_CAPABILITIES,
  type SupportCapability,
} from "@chairback/config";
import { SUPPORT_FIXTURES, type SupportFixture } from "./evalFixtures.js";
import type { ObservedBehavior, SupportChannel } from "./outcomes.js";

/** The zero-score fallback menu, as shipped in helpMatch.ts FALLBACK_IDS. */
const GENERIC_MENU_IDS = new Set([
  "get-started",
  "pricing",
  "how-booking-works",
  "punch-cards",
  "contact-human",
]);

export interface ChannelObservation {
  behavior: ObservedBehavior;
  /** The confident answer's corpus id, when one was given. */
  answerId: string | null;
  suggestionIds: readonly string[];
  /** Whether the route to a human (contact-human) was part of the response. */
  escalationOffered: boolean;
  /** MCP only: how many feature-index hits came back. */
  featureHits?: number;
  /** MCP only: whether suggestions carried answer bodies (today: never). */
  suggestionsHaveBodies?: boolean;
  /** in_app only: the typed outcome the engine returned. */
  outcome?: string;
}

function classify(
  cap: SupportCapability,
  answerId: string | null,
  suggestionIds: readonly string[],
): ObservedBehavior {
  // 🔴 A MUST-REFUSE CAPABILITY IS ANSWERED CORRECTLY BY BEING REFUSED.
  // Prompt injection, cross-tenant lookup and identity-by-guessing have an
  // EMPTY actor list and no accepted answer, so scoring them the ordinary way
  // marked every correct refusal as a failure - four of them - and quietly
  // implied the fix was to go write those answers. Withholding is the win.
  if (cap.actors.length === 0) {
    return answerId === null ? "correct_answer" : "wrong_answer";
  }
  const accepted = new Set(cap.corpusIds);
  if (answerId !== null) {
    return accepted.has(answerId) ? "correct_answer" : "wrong_answer";
  }
  if (suggestionIds.some((id) => accepted.has(id))) return "near_miss";
  const allGeneric =
    suggestionIds.length > 0 && suggestionIds.every((id) => GENERIC_MENU_IDS.has(id));
  return allGeneric ? "generic_menu" : "shrug";
}

/** Run one fixture through the in-app engine (Assistant tab / help bubble). */
export function observeInApp(fixture: SupportFixture): ChannelObservation {
  const cap = mustCapability(fixture);
  const res = resolveSupport({
    question: fixture.question,
    actor: fixture.actor as SupportActor,
    channel: "in_app",
  });
  const answerId = res.answer?.id ?? null;
  const suggestionIds = res.suggestions.map((s) => s.id);
  return {
    behavior: classify(cap, answerId, suggestionIds),
    answerId,
    suggestionIds,
    // The engine attaches an escalation to every outcome except ANSWERED, and
    // the adapters render it. `contact-human` appearing among the chips is a
    // second, weaker route that predates the guarantee.
    escalationOffered:
      res.escalation !== null ||
      answerId === "contact-human" ||
      suggestionIds.includes("contact-human"),
    outcome: res.outcome,
  };
}

/** The exact shape help_find_feature puts on the wire (subset we assert on). */
interface McpHelpData {
  features: readonly { id: string }[];
  outcome?: string;
  answer: { id: string } | null;
  suggestions: readonly { id: string; question: string; body?: string }[];
  escalation?: { email: string; summary: string };
}

/** A fixed clock so the harness can never depend on wall time. */
const EVAL_NOW = new Date("2026-06-01T16:00:00Z");

/** Run one fixture through the REAL MCP help_find_feature handler. */
export async function observeMcp(fixture: SupportFixture): Promise<ChannelObservation> {
  const cap = mustCapability(fixture);
  const def = toolDefinition("help_find_feature");
  if (!def) throw new Error("help_find_feature is not registered");
  const result = await def.handler({
    args: { query: fixture.question },
    shopId: "eval-shop",
    userId: "eval-user",
    role: "OWNER",
    chairFilterStaffId: null,
    hasAccess: true,
    now: EVAL_NOW,
  });
  if (!result.ok) {
    throw new Error(`help_find_feature refused an eval query: ${result.code}`);
  }
  const data = result.data as McpHelpData;
  const answerId = data.answer?.id ?? null;
  const suggestionIds = data.suggestions.map((s) => s.id);
  return {
    behavior: classify(cap, answerId, suggestionIds),
    answerId,
    suggestionIds,
    // The wire now carries an escalation on every non-answer, exactly as the
    // in-app adapters do. The two chip-based routes remain as weaker signals.
    escalationOffered:
      data.escalation !== undefined ||
      answerId === "contact-human" ||
      suggestionIds.includes("contact-human"),
    featureHits: data.features.length,
    // Every suggestion should now arrive WITH its body. `every` rather than
    // `some`: one body among four is still a menu.
    suggestionsHaveBodies:
      data.suggestions.length > 0 &&
      data.suggestions.every((s) => typeof s.body === "string" && s.body.length > 0),
    outcome: data.outcome,
  };
}

/* ───────────────────────── aggregate evaluation ─────────────────────────── */

export interface ChannelTally {
  correct_answer: number;
  near_miss: number;
  shrug: number;
  generic_menu: number;
  wrong_answer: number;
}

export interface EvalReport {
  /** fixtureId -> per-channel observed behavior. The exact baseline surface. */
  perFixture: Record<string, Partial<Record<SupportChannel, ObservedBehavior>>>;
  inApp: ChannelTally;
  mcp: ChannelTally;
  /**
   * Of the fixtures evaluated on both channels, how many resolved to the same
   * behavior class on each. Parity of failure counts as parity — the metric
   * tracks divergence, not quality.
   */
  channelAgreement: { agree: number; of: number };
  /**
   * Fixtures whose capability the corpus can answer (corpusIds non-empty)
   * that still did not produce a correct confident answer in-app.
   */
  answerableMissedInApp: readonly string[];
  /** Fixtures that produced a confidently WRONG in-app answer. */
  wrongInApp: readonly string[];
  /**
   * Capabilities with no corpus entry at all — structurally unanswerable
   * knowledge today, independent of phrasing.
   */
  corpusGapCapabilities: readonly string[];
  /** Capabilities with live-data class but no bound MCP tool. */
  mcpToolGaps: readonly string[];
  /** Misses (no confident answer) where no route to a human was offered. */
  missesWithoutEscalation: { inApp: number; mcp: number };
}

function emptyTally(): ChannelTally {
  return { correct_answer: 0, near_miss: 0, shrug: 0, generic_menu: 0, wrong_answer: 0 };
}

function mustCapability(fixture: SupportFixture): SupportCapability {
  const cap = capabilityById(fixture.capabilityId);
  if (!cap) throw new Error(`fixture ${fixture.id}: unknown capability ${fixture.capabilityId}`);
  return cap;
}

export async function runSupportEval(): Promise<EvalReport> {
  const perFixture: EvalReport["perFixture"] = {};
  const inApp = emptyTally();
  const mcp = emptyTally();
  let agree = 0;
  let both = 0;
  const answerableMissedInApp: string[] = [];
  const wrongInApp: string[] = [];
  let inAppMissNoEsc = 0;
  let mcpMissNoEsc = 0;

  for (const fixture of SUPPORT_FIXTURES) {
    const cap = mustCapability(fixture);
    const row: Partial<Record<SupportChannel, ObservedBehavior>> = {};

    let inAppObs: ChannelObservation | null = null;
    if (fixture.channels.includes("in_app")) {
      inAppObs = observeInApp(fixture);
      row.in_app = inAppObs.behavior;
      inApp[inAppObs.behavior]++;
      if (cap.corpusIds.length > 0 && inAppObs.behavior !== "correct_answer") {
        answerableMissedInApp.push(fixture.id);
      }
      if (inAppObs.behavior === "wrong_answer") wrongInApp.push(fixture.id);
      if (inAppObs.behavior !== "correct_answer" && !inAppObs.escalationOffered) {
        inAppMissNoEsc++;
      }
    }

    if (fixture.channels.includes("mcp")) {
      const mcpObs = await observeMcp(fixture);
      row.mcp = mcpObs.behavior;
      mcp[mcpObs.behavior]++;
      if (mcpObs.behavior !== "correct_answer" && !mcpObs.escalationOffered) {
        mcpMissNoEsc++;
      }
      if (inAppObs) {
        both++;
        if (inAppObs.behavior === mcpObs.behavior) agree++;
      }
    }

    perFixture[fixture.id] = row;
  }

  const corpusGapCapabilities = SUPPORT_CAPABILITIES.filter(
    (c) => c.corpusIds.length === 0 && c.actors.length > 0,
  ).map((c) => c.id);

  const mcpToolGaps = SUPPORT_CAPABILITIES.filter(
    (c) =>
      c.actors.includes("mcp_user") &&
      (c.dataClass === "shop_data" || c.dataClass === "public_shop_config") &&
      c.mcpTool === null,
  ).map((c) => c.id);

  return {
    perFixture,
    inApp,
    mcp,
    channelAgreement: { agree, of: both },
    answerableMissedInApp,
    wrongInApp,
    corpusGapCapabilities,
    mcpToolGaps,
    missesWithoutEscalation: { inApp: inAppMissNoEsc, mcp: mcpMissNoEsc },
  };
}

/**
 * Contract-level check for live-data capabilities: is the bound tool real and
 * reachable for a MANAGER seat on an active plan? (The broadest ordinary seat;
 * per-role reachability is already pinned exhaustively in toolPolicy.test.ts.)
 */
export function boundToolReachable(cap: SupportCapability): boolean | null {
  if (!cap.mcpTool) return null;
  const decision = decideTool(cap.mcpTool, {
    role: "MANAGER",
    staffId: null,
    hasAccess: true,
    accessLevel: "READ_ONLY",
    scopes: READ_SCOPES,
  });
  return decision.ok;
}
