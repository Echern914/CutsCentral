import { z } from "zod";
import {
  FEATURE_CATEGORIES,
  resolveFeature,
  visibleFeatures,
  type FeatureIndexEntry,
  type NavDenial,
  type SeatRole,
} from "@chairback/config/features";
import type { HelpAnswer } from "@chairback/config/help";
import { findHelp, searchFeatures } from "@chairback/config/helpMatch";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";

/**
 * Product help and navigation. THE ONLY TOOLS THAT TOUCH NO SHOP DATA AT ALL.
 *
 * ── 🔴 WHY THESE RETURN FEATURE IDS AND NOT URLS ─────────────────────────────
 *
 * This is the seam PR A's registry exists for. The model asks "where do I turn
 * on deposits?" and gets back an id the registry resolved, plus the href the
 * registry chose for THIS seat. It never gets to name a path, and we never
 * follow one it invented. If the destination moves, one table changes and every
 * assistant is correct the next request; if a feature is closed to this caller,
 * the registry withholds it and says why rather than handing over a link that
 * 403s — which was the whole complaint that produced the registry.
 *
 * Nothing here reads the database. That is what makes them safe to leave
 * available to a lapsed shop: a barber whose plan ended still has to be able to
 * ask "how do I start paying again", and refusing that would be an own goal.
 */

const findSchema = z
  .object({
    query: z.string().min(1).max(200),
  })
  .strict();

/** How a withheld destination is explained. Fixed strings — no input echoed. */
const DENIAL_COPY: Record<NavDenial, string> = {
  unknown_feature: "There's no such feature in ChairBack.",
  role: "This is a manager-only area, so it isn't available to this seat.",
  plan: "This needs an active ChairBack plan.",
  flag: "This feature is switched off for this shop.",
  demo: "This isn't available in the demo.",
  in_app: "This has to be done in a web browser rather than the app.",
};

/**
 * A help answer on the wire.
 *
 * Its `action` is a FEATURE ID, never a route — the corpus stopped carrying
 * hrefs precisely because 72 hand-written ones drifted from the index they
 * duplicated. Resolving it here makes the button role-aware for free: a seat
 * that cannot open the destination simply gets no action.
 */
function wireAnswer(a: HelpAnswer, ctx: { role: SeatRole; hasAccess: boolean }) {
  const action = a.action ? resolveFeature(a.action.featureId, ctx) : null;
  return {
    id: a.id,
    question: a.q,
    body: a.a,
    action:
      a.action && action?.ok
        ? {
            label: a.action.label,
            featureId: a.action.featureId,
            href: action.href,
          }
        : undefined,
  };
}

/** The shape a feature takes on the wire. Stable; the model keys off `id`. */
function wire(entry: FeatureIndexEntry, href: string | null) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    href,
  };
}

async function findFeature(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = findSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;
  const { query } = parsed.data;

  // The seat is what the registry resolves against. `inApp` is deliberately
  // NOT set: an MCP client is not the iOS shell, so the App Store billing
  // restriction does not apply to it.
  const ctx = { role: inv.role, hasAccess: inv.hasAccess };

  // Features first - "where do I ..." is nearly always a navigation question.
  const hits = searchFeatures(query, visibleFeatures(ctx)).slice(0, 5);

  // Then the help corpus, which answers "how does X work" rather than "where".
  const help = findHelp(query);

  return {
    ok: true,
    data: {
      features: hits.map((h) => {
        const r = resolveFeature(h.entry.id, ctx);
        return {
          ...wire(h.entry, r.ok ? r.href : null),
          // A feature that matched but is closed to this seat is returned WITH
          // the reason rather than dropped. The model should be able to say
          // "your manager can do that" instead of "I couldn't find it".
          unavailable: r.ok ? undefined : DENIAL_COPY[r.reason],
        };
      }),
      answer: help.kind === "answer" && help.answer ? wireAnswer(help.answer, ctx) : null,
      suggestions: help.suggestions.slice(0, 4).map((a) => ({ id: a.id, question: a.q })),
    },
  };
}

const listSchema = z
  .object({
    category: z.string().min(1).max(40).optional(),
  })
  .strict();

async function listFeatures(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = listSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;

  const ctx = { role: inv.role, hasAccess: inv.hasAccess };
  // 🔴 visibleFeatures already applies role, plan and listing rules. Filtering
  // the full FEATURE_INDEX by hand here would be a second, drifting copy of
  // exactly the logic the registry centralises.
  let entries = visibleFeatures(ctx);
  if (parsed.data.category) {
    const wanted = parsed.data.category;
    entries = entries.filter((e) => e.category === wanted);
  }

  return {
    ok: true,
    data: {
      categories: FEATURE_CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
      features: entries.map((e) => {
        const r = resolveFeature(e.id, ctx);
        return wire(e, r.ok ? r.href : null);
      }),
    },
  };
}

export const helpTools: ToolDefinition[] = [
  {
    name: "help_find_feature",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What the barber is trying to do, in their own words. e.g. 'take a deposit', 'stop double bookings'.",
          maxLength: 200,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: findFeature,
  },
  {
    name: "help_list_features",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional category id to narrow to. Omit for everything available.",
          maxLength: 40,
        },
      },
      additionalProperties: false,
    },
    handler: listFeatures,
  },
];
