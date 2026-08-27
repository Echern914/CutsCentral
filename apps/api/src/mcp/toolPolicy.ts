import { READ_SCOPES, roleMeets, type SeatRole } from "@chairback/config";
import type { McpAccessLevel } from "@chairback/db";

/**
 * WHO MAY CALL WHICH TOOL, written down once.
 *
 * ── WHY THIS IS A TABLE AND NOT A SET OF `if`s IN EACH HANDLER ────────────────
 *
 * An MCP tool is reached by an untrusted model that was handed a sentence by a
 * human. It can ask for anything, in any order, with any arguments, and it will
 * cheerfully try again with different words if refused. Permission logic spread
 * across ten handlers is ten chances to forget the lapsed-shop case or the
 * employee case — and the failure mode is silent: the tool returns data and
 * nobody notices it was the wrong barber's data.
 *
 * So every tool declares its policy HERE, the dispatcher refuses anything this
 * table does not describe, and the whole matrix is asserted in one test rather
 * than inferred from ten.
 *
 * ── 🔴 DEFAULT DENY ──────────────────────────────────────────────────────────
 *
 * `decideTool` refuses any name absent from `TOOL_POLICIES`. A handler that is
 * registered but not declared here is UNREACHABLE, not wide open, and the test
 * suite asserts the two sets match exactly in both directions. Adding a tool is
 * therefore two deliberate acts, and forgetting the policy half fails closed.
 *
 * ── 🔴 NO BLANKET BILLING CHECK, ON PURPOSE ──────────────────────────────────
 *
 * `requireMcpAuth` establishes IDENTITY — who is asking, at which shop, in what
 * role, right now. It does NOT ask whether the shop has paid, because "has this
 * shop lapsed" is not one answer for the whole surface: the product already says
 * a lapsed shop can still read why it stopped working and can still read its own
 * client book, while everything that makes the shop FUNCTION stops.
 *
 * A single check in the middleware could only be all-or-nothing, and either
 * choice is wrong — deny and a lapsed barber cannot ask why they lapsed; allow
 * and the wall has a hole the size of the entire assistant. So the wall is
 * per-tool, and each `whenLapsed` below cites the route it mirrors.
 *
 * ── WHERE EACH ROW COMES FROM ────────────────────────────────────────────────
 *
 * Nothing here is a new product decision. Every row mirrors the gate the
 * equivalent HTTP route already carries (app.ts's WALLED block is the written
 * form), because an assistant that can read more than the dashboard would be a
 * privilege-escalation path dressed up as a feature.
 */

/** The scopes this release can serve. Narrowed from the config union for typing. */
export type ReadScopeName = (typeof READ_SCOPES)[number];

/** How a tool's results are narrowed to the caller's own work. */
export type ChairScope =
  /** Whole-shop data. Managers and owners only, by role. */
  | "shop"
  /**
   * Narrowed to the caller's own chair when the caller is a BARBER; whole-shop
   * for a manager or owner, exactly as the dashboard behaves.
   */
  | "own_chair"
  /** Carries no shop data at all — product help and navigation. */
  | "none";

export interface ToolPolicy {
  /** The wire name. Snake case, `family_action`, stable forever once shipped. */
  name: string;
  /** The OAuth scope the human must have consented to. */
  scope: ReadScopeName;
  /** The lowest seat that may call it. */
  minRole: SeatRole;
  /**
   * What happens when the shop's subscription has lapsed.
   *
   * 🔴 Every "allow" must name the existing route it mirrors. If there isn't
   * one, the answer is "deny" — this table is not the place to invent a new
   * hole in the wall.
   */
  whenLapsed: "allow" | "deny";
  /** Why `whenLapsed` is what it is. Read by humans, asserted by tests. */
  lapsedRationale: string;
  chairScope: ChairScope;
  /**
   * True for a tool that changes something.
   *
   * 🔴 A LOAD-BEARING `false`, like `WRITE_SCOPES` being empty in mcpScopes.ts.
   * Nothing in this release writes, no connection can be minted at MANAGEMENT
   * level, and a test asserts every row here stays `false` until the proposal
   * flow lands. The field exists now so the write PR adds tools behind a check
   * that already exists and is already tested.
   */
  write: boolean;
  /** One line, shown to the model in `tools/list`. */
  description: string;
}

/**
 * The matrix.
 *
 * Ordered by how much they can see, least to most, which is also roughly the
 * order a human would be comfortable granting them.
 */
export const TOOL_POLICIES: readonly ToolPolicy[] = [
  {
    name: "help_find_feature",
    scope: "chairback:help:read",
    minRole: "BARBER",
    whenLapsed: "allow",
    lapsedRationale:
      "Carries no shop data. Product help is how a lapsed barber finds the billing page at all.",
    chairScope: "none",
    write: false,
    description:
      "Find a ChairBack feature by name or task and get the page for it, or the reason it is not available to you.",
  },
  {
    name: "help_list_features",
    scope: "chairback:help:read",
    minRole: "BARBER",
    whenLapsed: "allow",
    lapsedRationale: "Carries no shop data. Same reasoning as help_find_feature.",
    chairScope: "none",
    write: false,
    description: "List the ChairBack features available to you, by category.",
  },
  {
    name: "readiness_report",
    scope: "chairback:readiness:read",
    minRole: "BARBER",
    whenLapsed: "allow",
    lapsedRationale:
      "Mirrors /api/readiness, the one dashboard router deliberately never walled: a lapsed shop has to be able to read WHY booking stopped, and 'your subscription lapsed' is one of the answers it gives.",
    chairScope: "own_chair",
    write: false,
    description:
      "What still needs setting up before this shop can take bookings, and what is currently broken.",
  },
  {
    name: "clients_search",
    scope: "chairback:clients:read",
    minRole: "MANAGER",
    whenLapsed: "allow",
    lapsedRationale:
      "Mirrors the isOwnDataRead hole in the wall: a lapsed shop keeps GET access to its own client book, because locking a barber out of their own customer list reads as holding data hostage.",
    chairScope: "shop",
    write: false,
    // 🔴 BY NAME, NOT BY PHONE, and the description has to say so. Accepting a
    // phone number as a search term would turn this into a lookup oracle - ask
    // it about a number and learn whether that person is a customer here. The
    // name search answers the question a barber actually asks.
    description:
      "Find clients by name, or list who is overdue for a visit. Returns summaries, never contact details.",
  },
  {
    name: "client_detail",
    scope: "chairback:clients:read",
    minRole: "MANAGER",
    whenLapsed: "allow",
    lapsedRationale: "Mirrors GET /clients/:id and its ledger, both inside isOwnDataRead.",
    chairScope: "shop",
    write: false,
    description: "One client's visit history, spend and loyalty standing.",
  },
  {
    name: "calendar_agenda",
    scope: "chairback:calendar:read",
    minRole: "BARBER",
    whenLapsed: "deny",
    lapsedRationale:
      "Mirrors /api/barber and /api/booking, both walled. A lapsed shop is not taking bookings, so its calendar is not a thing the assistant reads.",
    chairScope: "own_chair",
    write: false,
    description: "Appointments and blocked time for a day or a range, for a chair or the shop.",
  },
  {
    name: "calendar_openings",
    scope: "chairback:calendar:read",
    minRole: "BARBER",
    whenLapsed: "deny",
    lapsedRationale:
      "Mirrors /api/booking, walled. Openings on a shop that cannot be booked are not an answer.",
    chairScope: "own_chair",
    write: false,
    description: "Open bookable times in a date range.",
  },
  {
    name: "waitlist_list",
    scope: "chairback:waitlist:read",
    minRole: "MANAGER",
    whenLapsed: "deny",
    lapsedRationale:
      "Mirrors GET /api/dashboard/waitlist — manager-gated, and NOT one of the isOwnDataRead paths, so it is walled with the rest of the product.",
    chairScope: "shop",
    write: false,
    description: "Who is waiting for a slot, and what they are waiting for.",
  },
  {
    name: "business_summary",
    scope: "chairback:business:read",
    minRole: "MANAGER",
    whenLapsed: "deny",
    lapsedRationale: "Mirrors /api/insights — manager-gated and walled.",
    chairScope: "shop",
    write: false,
    description: "Revenue, bookings and chair utilisation over a date range.",
  },
  {
    name: "integration_health",
    scope: "chairback:integrations:read",
    minRole: "MANAGER",
    whenLapsed: "deny",
    lapsedRationale:
      "Mirrors the integrations settings under /api/booking — manager-gated and walled. A lapsed shop still learns about a broken Acuity link through readiness_report, which is not walled.",
    chairScope: "shop",
    write: false,
    description: "Whether Acuity and Square are connected, syncing and mapped to chairs.",
  },
] as const;

const BY_NAME = new Map(TOOL_POLICIES.map((p) => [p.name, p]));

/** Look a policy up by tool name. Undefined means "not a tool", i.e. denied. */
export function toolPolicy(name: string): ToolPolicy | undefined {
  return BY_NAME.get(name);
}

/**
 * Everything the matrix needs to know about the caller.
 *
 * 🔴 EVERY FIELD IS SERVER-DERIVED. `role` and `staffId` come from
 * `resolveMcpSeat` re-reading live membership; `scopes` and `accessLevel` come
 * from the stored grant; `hasAccess` comes from the shop's billing row. NOTHING
 * here is read from the JSON-RPC request, because the thing sending it is a
 * language model that will say whatever gets it an answer.
 */
export interface ToolContext {
  role: SeatRole;
  /** The chair this seat works, when linked to one. Null for an owner. */
  staffId: string | null;
  /** `hasActiveAccess(shop)`. False only for a genuinely lapsed shop. */
  hasAccess: boolean;
  accessLevel: McpAccessLevel;
  scopes: readonly string[];
}

/** Why a call was refused. Short slugs — these reach the audit trail verbatim. */
export type ToolDenial =
  /** No such tool, or a tool with no policy. The default-deny answer. */
  | "unknown_tool"
  | "insufficient_scope"
  | "role"
  | "plan"
  /** A write tool on a read-only connection. Unreachable in this release. */
  | "write_access_required"
  /** A barber whose seat is not linked to a chair asked for chair-scoped data. */
  | "no_chair";

export type ToolDecision =
  | {
      ok: true;
      policy: ToolPolicy;
      /**
       * The staffId the handler MUST filter by, or null for whole-shop.
       *
       * 🔴 THE HANDLER DOES NOT GET TO DECIDE THIS, and must never accept a
       * staffId from the request — that is the exact bug the barber router's
       * header comment warns about, where changing a query param reads a
       * colleague's book.
       */
      chairFilterStaffId: string | null;
    }
  | { ok: false; reason: ToolDenial; policy?: ToolPolicy };

/**
 * The one gate.
 *
 * Deliberately PURE — no Prisma, no Express, no clock. The readiness engine is
 * built the same way and for the same reason: a permission matrix you cannot
 * exhaustively test is a permission matrix you are guessing at. Every cell of
 * tools × roles × lapsed is a table-driven assertion because this function takes
 * plain values.
 *
 * ORDER IS DELIBERATE. Scope is checked before role, and role before billing, so
 * the reason a caller is told is the most specific one that is also the least
 * informative about the shop: "you were not granted this" leaks nothing, whereas
 * leading with `plan` would tell any client holding a token whether a shop is
 * paying.
 */
export function decideTool(name: string, ctx: ToolContext): ToolDecision {
  const policy = BY_NAME.get(name);
  // 🔴 DEFAULT DENY. Unknown name, or a handler someone forgot to declare.
  if (!policy) return { ok: false, reason: "unknown_tool" };
  return decideForPolicy(policy, ctx);
}

/**
 * The decision itself, split from the lookup for ONE reason: it is the only way
 * to test the write gate before a write tool exists.
 *
 * Every row in `TOOL_POLICIES` is `write: false`, so a test driving
 * `decideTool` can never reach that branch — and an untested refusal is a
 * refusal you are hoping for. A test can hand this function a synthetic write
 * policy and prove a READ_ONLY connection is turned away, so the write PR
 * inherits a gate with a passing test instead of writing both at once.
 */
export function decideForPolicy(policy: ToolPolicy, ctx: ToolContext): ToolDecision {
  if (policy.write && ctx.accessLevel !== "MANAGEMENT") {
    return { ok: false, reason: "write_access_required", policy };
  }

  if (!ctx.scopes.includes(policy.scope)) {
    return { ok: false, reason: "insufficient_scope", policy };
  }

  if (!roleMeets(ctx.role, policy.minRole)) {
    return { ok: false, reason: "role", policy };
  }

  if (!ctx.hasAccess && policy.whenLapsed === "deny") {
    return { ok: false, reason: "plan", policy };
  }

  // Chair scoping. A BARBER sees their own chair; anyone senior sees the shop.
  if (policy.chairScope === "own_chair" && ctx.role === "BARBER") {
    if (!ctx.staffId) {
      // A seat with no chair cannot be narrowed, and the safe answer to "I
      // cannot narrow this" is not "then show everything".
      return { ok: false, reason: "no_chair", policy };
    }
    return { ok: true, policy, chairFilterStaffId: ctx.staffId };
  }

  return { ok: true, policy, chairFilterStaffId: null };
}

/**
 * The tools a given caller may actually call, for `tools/list`.
 *
 * 🔴 THE LIST IS FILTERED, NOT ANNOTATED. A model shown a tool it cannot call
 * will call it, be refused, rephrase, and call it again — burning the human's
 * tokens and filling the audit trail with denials that look like an attack. It
 * is also a small disclosure: the absence of `business_summary` says nothing,
 * whereas "business_summary (denied: plan)" tells a client the shop has lapsed.
 */
export function listableTools(ctx: ToolContext): ToolPolicy[] {
  return TOOL_POLICIES.filter((p) => decideTool(p.name, ctx).ok);
}
