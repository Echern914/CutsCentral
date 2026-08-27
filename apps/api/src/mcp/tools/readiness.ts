import { z } from "zod";
import { resolveFeature, type SeatRole } from "@chairback/config/features";
import {
  buildBarberReadiness,
  buildReadiness,
  type ReadinessItem,
} from "../../engines/readiness.js";
import { collectCapabilities, collectReadinessFacts } from "../../services/readinessFacts.js";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";

/**
 * "What still needs doing, and what's broken?"
 *
 * 🔴 NO NEW LOGIC, DELIBERATELY. This is the same engine `/api/readiness`
 * serves, called the same way, scoped the same way. The readiness rules are
 * subtle - conditional items, silent-when-done, chair-level applicability - and
 * a second implementation for the assistant would drift within a release and
 * then confidently tell a barber something the dashboard disagrees with.
 *
 * 🔴 IT IS ALSO THE ONE SHOP-DATA TOOL A LAPSED SHOP KEEPS, mirroring the one
 * dashboard router that is never walled. "Your subscription lapsed" is an answer
 * this report gives, and walling it would 402 exactly the shop that needs it.
 *
 * SAFE TO SHOW A MODEL. Every `evidence` string is written to contain no
 * customer data (see the engine's ReadinessItem contract), chairs are named as
 * chairs rather than people, and nothing here carries a phone number or an
 * email. That property belongs to the engine and is asserted there.
 *
 * ── ONE DELIBERATE DIVERGENCE FROM THE HTTP ROUTE ────────────────────────────
 *
 * A BARBER whose seat is not linked to a chair is REFUSED here, where
 * `/api/readiness` answers 200 with `chair: null`. The route has a screen to
 * render, so it says "ask your manager to link your chair" in the UI; the tool
 * has no screen, and the `no_chair` refusal carries exactly that sentence.
 *
 * The alternative - allowing it through with no chair filter - is the one thing
 * that must not happen: "I cannot narrow this to your chair" silently becoming
 * "then show the whole shop" is how an employee ends up reading every chair's
 * readiness. Refusing is the safe direction, and it loses nothing, because
 * `buildBarberReadiness(report, null)` returns an empty report anyway.
 */

const schema = z.object({}).strict();

/**
 * Resolve an item's CTA for the seat that asked - identical to the HTTP route's
 * `wireCta`, and for the identical reason: the engine names a FEATURE and the
 * registry owns the route, so an employee is never handed a manager-only link.
 */
function wireCta(cta: ReadinessItem["cta"], role: SeatRole) {
  if (!cta) return undefined;
  const r = resolveFeature(cta.featureId, { role });
  if (!r.ok) return undefined;
  return { label: cta.label, featureId: cta.featureId, href: r.href };
}

/**
 * The model gets a NARROWER item than the dashboard does.
 *
 * Dropped on purpose: `silentWhenDone`, `deferrable`, `scope` and `klass` are
 * rendering hints for a UI that has a screen to lay out. A model reading them
 * would have to be told what to do with them, and every field it does not need
 * is context spent on the human's plan rather than on their question.
 */
function wireItem(i: ReadinessItem, role: SeatRole) {
  return {
    id: i.id,
    title: i.title,
    why: i.why,
    done: i.done,
    blocksLaunch: i.blocksLaunch,
    evidence: i.evidence,
    whoFixesIt: i.role,
    cta: wireCta(i.cta, role),
    ...(i.staffId ? { staffId: i.staffId } : {}),
  };
}

/**
 * Items worth putting in front of someone: relevant to this shop, not yet done.
 *
 * `silentWhenDone` needs no test of its own here — an item that is not done is
 * never silent, and one that is done is already excluded.
 */
const outstanding = (items: ReadinessItem[]) => items.filter((i) => i.applicable && !i.done);

async function report(inv: ToolInvocation): Promise<ToolResult> {
  if (!schema.safeParse(inv.args ?? {}).success) return INVALID_ARGS;

  const facts = await collectReadinessFacts(inv.shopId);
  if (!facts) {
    return {
      ok: false,
      code: "shop_not_found",
      message: "That shop is no longer available.",
    };
  }
  const full = buildReadiness(facts, collectCapabilities());

  // 🔴 The chair filter comes from the POLICY, not from arguments. A barber
  // gets their own chair; the decision that it is their own was made before
  // this handler ran.
  if (inv.chairFilterStaffId) {
    const barber = buildBarberReadiness(full, inv.chairFilterStaffId);
    return {
      ok: true,
      resource: { type: "readiness", id: barber.staffId },
      data: {
        scope: "chair",
        chair: barber.chair
          ? {
              staffId: barber.chair.staffId,
              name: barber.chair.name,
              active: barber.chair.active,
              bookable: barber.chair.bookable,
              complete: barber.chair.completeCount,
              applicable: barber.chair.applicableCount,
            }
          : null,
        // What they can fix themselves, then what to ask a manager for. The
        // split is the engine's, not ours.
        yours: barber.personal.map((i) => wireItem(i, inv.role)),
        askYourManager: barber.managerOwned.map((i) => wireItem(i, inv.role)),
      },
    };
  }

  return {
    ok: true,
    resource: { type: "readiness", id: full.shopId },
    data: {
      scope: "shop",
      liveNow: full.liveNow,
      canGoLive: full.canGoLive,
      blocking: full.blocking.map((i) => wireItem(i, inv.role)),
      outstanding: outstanding(full.items).map((i) => wireItem(i, inv.role)),
      improve: full.improve.map((i) => wireItem(i, inv.role)),
      milestones: full.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        done: m.done,
        complete: m.completeCount,
        applicable: m.applicableCount,
      })),
      chairs: full.staff.map((s) => ({
        staffId: s.staffId,
        name: s.name,
        active: s.active,
        bookable: s.bookable,
        complete: s.completeCount,
        applicable: s.applicableCount,
      })),
    },
  };
}

export const readinessTools: ToolDefinition[] = [
  {
    name: "readiness_report",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: report,
  },
];
