import { Router } from "express";
import { requireShop, requireUser } from "../middleware/auth.js";
import { dashboardLimiter } from "../middleware/rateLimit.js";
import {
  buildBarberReadiness,
  buildReadiness,
  type ReadinessItem,
} from "../engines/readiness.js";
import { collectCapabilities, collectReadinessFacts } from "../services/readinessFacts.js";

/**
 * Launch readiness, read-only.
 *
 * 🔴 DELIBERATELY NOT BEHIND `requireActiveAccess`, and it is the only dashboard
 * router that isn't. Every other one is walled (see the block comment in app.ts)
 * because a lapsed shop stops working - but the entire point of this endpoint is
 * to answer "why can nobody book me?", and a lapsed subscription is one of the
 * answers it has to be able to give. Walling it would 402 exactly the shop that
 * most needs to read it. Authentication, shop isolation and rate limiting all
 * still apply.
 *
 * BOTH ROUTES ARE PURE READS. No write, no repair, no toggle - in particular
 * nothing here ever touches `publicPageEnabled`. A shop that fails a check keeps
 * serving exactly as it did before. There is no go-live action in this router;
 * that is a later PR.
 *
 * ROLE SCOPING. An OWNER or MANAGER gets the whole shop report. A BARBER gets
 * their OWN chair and the personal items they can act on, and nothing else - no
 * shop milestones, no other chairs, no money. The chair is resolved from
 * `req.shopStaffId`, which requireShop derives from the authenticated seat; a
 * staffId is NEVER read from the request, so one barber cannot ask about
 * another's chair.
 */
export const readinessRouter: Router = Router();
readinessRouter.use(requireUser, requireShop, dashboardLimiter);

/** Serialize an item for the wire. Shape is stable; future UI keys off `id`. */
function wireItem(i: ReadinessItem) {
  return {
    id: i.id,
    scope: i.scope,
    milestone: i.milestone,
    title: i.title,
    why: i.why,
    klass: i.klass,
    applicable: i.applicable,
    done: i.done,
    silentWhenDone: i.silentWhenDone,
    evidence: i.evidence,
    blocksLaunch: i.blocksLaunch,
    deferrable: i.deferrable,
    role: i.role,
    cta: i.cta,
    ...(i.staffId ? { staffId: i.staffId } : {}),
  };
}

/** GET /api/readiness - the full report, scoped to the caller's role. */
readinessRouter.get("/", async (req, res) => {
  const shopId = req.shop!.id;
  const facts = await collectReadinessFacts(shopId);
  if (!facts) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const report = buildReadiness(facts, collectCapabilities());

  if (req.shopRole === "BARBER") {
    // Own chair only. Everything shop-wide is dropped rather than zeroed: an
    // employee's readiness is their chair, and a shop percentage they cannot
    // move is noise on their screen.
    const barber = buildBarberReadiness(report, req.shopStaffId ?? null);
    res.json({
      scope: "barber",
      staffId: barber.staffId,
      // null = their seat isn't linked to a chair yet; the UI says what to ask
      // their manager for rather than rendering an empty day.
      chair: barber.chair
        ? {
            staffId: barber.chair.staffId,
            name: barber.chair.name,
            active: barber.chair.active,
            bookable: barber.chair.bookable,
            applicableCount: barber.chair.applicableCount,
            completeCount: barber.chair.completeCount,
          }
        : null,
      personal: barber.personal.map(wireItem),
      managerOwned: barber.managerOwned.map(wireItem),
      complete: barber.complete,
      applicable: barber.applicable,
    });
    return;
  }

  res.json({
    scope: "shop",
    shopId: report.shopId,
    liveNow: report.liveNow,
    canGoLive: report.canGoLive,
    goLiveGateApplies: report.goLiveGateApplies,
    milestones: report.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      done: m.done,
      blocking: m.blocking.map(wireItem),
      applicableCount: m.applicableCount,
      completeCount: m.completeCount,
    })),
    milestonesComplete: report.milestonesComplete,
    milestonesBlocking: report.milestonesBlocking,
    blocking: report.blocking.map(wireItem),
    items: report.items.map(wireItem),
    improve: report.improve.map(wireItem),
    applicableRequiredCount: report.applicableRequiredCount,
    completeRequiredCount: report.completeRequiredCount,
    staff: report.staff.map((s) => ({
      staffId: s.staffId,
      name: s.name,
      active: s.active,
      bookable: s.bookable,
      applicableCount: s.applicableCount,
      completeCount: s.completeCount,
      items: s.items.map(wireItem),
      blocking: s.blocking.map(wireItem),
    })),
  });
});

/**
 * GET /api/readiness/summary - the cheap shape.
 *
 * What a nav badge and a dashboard card need, and nothing more. It exists so
 * those surfaces never pull the full item list on every render, and so the
 * number they show is the FOUR-milestone one rather than an item count.
 */
readinessRouter.get("/summary", async (req, res) => {
  const shopId = req.shop!.id;
  const facts = await collectReadinessFacts(shopId);
  if (!facts) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const report = buildReadiness(facts, collectCapabilities());

  if (req.shopRole === "BARBER") {
    const barber = buildBarberReadiness(report, req.shopStaffId ?? null);
    const outstanding = barber.personal.filter((i) => !i.done).length;
    res.json({
      scope: "barber",
      complete: barber.complete,
      applicable: barber.applicable,
      // The badge count for an employee: only what THEY can finish.
      incompletePersonal: outstanding,
      chairLinked: barber.chair !== null,
    });
    return;
  }

  const next = report.milestones.find((m) => !m.done) ?? null;
  res.json({
    scope: "shop",
    milestonesComplete: report.milestonesComplete,
    milestonesTotal: report.milestones.length,
    milestonesBlocking: report.milestonesBlocking,
    canGoLive: report.canGoLive,
    liveNow: report.liveNow,
    goLiveGateApplies: report.goLiveGateApplies,
    // Where a "Continue setup" button should land.
    nextMilestone: next ? { id: next.id, title: next.title } : null,
  });
});
