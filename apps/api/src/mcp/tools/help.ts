import { z } from "zod";
import {
  FEATURE_CATEGORIES,
  resolveFeature,
  visibleFeatures,
  type FeatureIndexEntry,
  type NavDenial,
  type SeatRole,
} from "@chairback/config/features";
import { searchFeatures } from "@chairback/config/helpMatch";
import {
  actorForSeat,
  resolveSupport,
  resolveSupportAnswerById,
  type SupportResolution,
} from "@chairback/config/supportEngine";
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
 *
 * ── 🔴 WHY THESE CALL resolveSupport AND NOT findHelp ────────────────────────
 *
 * The in-app assistant and this connector answer out of ONE corpus, and they
 * used to answer from it with materially different quality. A miss here handed
 * the host model four question TITLES with no bodies and no tool that could
 * redeem an id - a dead end dressed as a menu - while the web bubble held the
 * whole answer object and rendered it on a tap. Worse, the four-item slice cut
 * off `contact-human`, so the one path where the connector knew nothing was
 * also the one where it withheld the way to reach a person.
 *
 * Going through the shared engine fixes all of that at once: bodies come back
 * on suggestions, an escalation rides along on every non-answer, and the actor
 * gate that the web surfaces already respect applies here too.
 */

const findSchema = z
  .object({
    query: z.string().min(1).max(200),
  })
  .strict();

const getSchema = z
  .object({
    id: z.string().min(1).max(80),
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
 * duplicated. The engine resolved it against this seat already, so a seat that
 * cannot open the destination simply gets no action.
 */
function wireAnswer(r: SupportResolution) {
  const a = r.answer;
  if (!a) return null;
  return {
    id: a.id,
    question: a.question,
    body: a.body,
    action: a.action ?? undefined,
  };
}

/**
 * Suggestions, WITH their bodies.
 *
 * 🔴 The id alone was the defect. A host model given `{id, question}` and no
 * way to look an id up can only re-ask in prose and hope the matcher lands
 * somewhere better - so it usually relayed the titles to the barber as a menu,
 * which is precisely the "it just gives me options" complaint.
 */
function wireSuggestions(r: SupportResolution, inv: ToolInvocation) {
  return r.suggestions.map((sug) => {
    const full = resolveSupportAnswerById(sug.id, supportRequestBase(inv));
    return {
      id: sug.id,
      question: sug.question,
      body: full.answer?.body,
    };
  });
}

/** The actor/seat every call in this file resolves against. */
function supportRequestBase(inv: ToolInvocation) {
  return {
    // An MCP token is minted FOR a seat and can never exceed it. The engine
    // gates capabilities by actor, so the seat has to arrive intact.
    actor: actorForSeat(inv.role),
    channel: "mcp" as const,
    // `inApp` is deliberately unset: an MCP client is not the iOS shell, so
    // the App Store billing restriction does not apply to it.
    seat: { role: inv.role, hasAccess: inv.hasAccess },
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

  const ctx = { role: inv.role, hasAccess: inv.hasAccess };

  // Features first - "where do I ..." is nearly always a navigation question.
  //
  // 🔴 searchFeatures is strict AND: every literally typed token must land on
  // an entry. That is right for a keyboard palette and wrong for a sentence
  // relayed by a model, so a miss here is normal and must not be read as "no
  // such feature" - the corpus answer below is the real reply.
  const hits = searchFeatures(query, visibleFeatures(ctx)).slice(0, 5);

  const resolution = resolveSupport({ question: query, ...supportRequestBase(inv) });

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
      outcome: resolution.outcome,
      answer: wireAnswer(resolution),
      // Bodies included, and NOT sliced: the four-item cut used to drop
      // `contact-human` on exactly the queries that matched nothing.
      suggestions: wireSuggestions(resolution, inv),
      // 🔴 Present on every outcome except ANSWERED. The host model must never
      // have to invent a way for the barber to reach a person.
      escalation: resolution.escalation ?? undefined,
    },
  };
}

/**
 * Redeem a suggestion id for its full answer.
 *
 * `helpAnswerById` has existed since the corpus did, and the web bubble has
 * always used it to turn a tapped chip into an answer. It was simply never
 * exposed here, which is why a suggestion over MCP was a title and a shrug.
 */
async function getAnswer(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = getSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;
  const resolution = resolveSupportAnswerById(parsed.data.id, supportRequestBase(inv));
  if (!resolution.answer) {
    return {
      ok: false,
      code: "no_such_answer",
      message: "There is no help topic with that id. Search again with help_find_feature.",
    };
  }
  return {
    ok: true,
    data: { outcome: resolution.outcome, answer: wireAnswer(resolution) },
    resource: { type: "help_answer", id: parsed.data.id },
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
        // 🔴 The REASON, not just a null href. visibleFeatures deliberately
        // lists a lapsed shop everything, so without this a barber's model saw
        // a full catalogue of unexplained dead links and could not tell
        // "manager only" from "your plan ended" from "switched off".
        return {
          ...wire(e, r.ok ? r.href : null),
          unavailable: r.ok ? undefined : DENIAL_COPY[r.reason],
        };
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
            "What the barber is trying to do, in their own words - a whole question is fine. e.g. 'why did a client not get their confirmation email', 'deposits'.",
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
  {
    name: "help_get_answer",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The id of a suggestion returned by help_find_feature. Use this to read a suggested topic in full rather than guessing at its wording.",
          maxLength: 80,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: getAnswer,
  },
];
