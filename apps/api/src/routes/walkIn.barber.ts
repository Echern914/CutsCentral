import { Router, type Request, type Response } from "express";
import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireRole } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import {
  claimEntry,
  listQueue,
  markLeft,
  markNoShow,
  markReady,
  returnToLine,
  WalkInDuplicateEntryError,
  WalkInIllegalTransitionError,
  WalkInNotFoundError,
  WalkInStaffError,
  WalkInStaleTransitionError,
  type QueueActor,
  type WalkInEntryView,
} from "../engines/walkInQueue.js";
import { estimateQueue } from "../engines/walkInEstimate.js";

/**
 * Walk-In Mode: the BARBER surface. A barber seat never reaches
 * /api/walk-ins (requireManager, same wall as /api/booking), so their queue
 * view and their own-chair actions live here - the same allow-list posture
 * as routes/barber.ts, and the same scoping rule:
 *
 * 🔴 THE CHAIR COMES FROM req.shopStaffId, NEVER FROM THE REQUEST. Claiming
 * writes it; ready/return/no-show carry it in the CAS where-clause, so
 * acting on another chair's customer is structurally a 0-count 409 - not a
 * check a handler could forget.
 *
 * Managers and owners pass the role gate too (a working owner claims from
 * their own chair like anyone else), but a seat with NO linked chair gets
 * 403 no_chair on actions - the manager board is their surface.
 */
export const walkInBarberRouter: Router = Router();

function requireWalkInMode(
  _req: Request,
  res: Response,
  next: () => void,
): void {
  if (!apiEnv().WALK_IN_MODE_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

walkInBarberRouter.use(
  requireWalkInMode,
  requireUser,
  requireShop,
  requireRole("OWNER", "MANAGER", "BARBER"),
  requireActiveAccess,
);

async function loadShop(shopId: string) {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      timezone: true,
      walkInEnabled: true,
      walkInAcceptingNow: true,
    },
  });
}

function answerError(res: Response, err: unknown): boolean {
  if (err instanceof WalkInNotFoundError) {
    res.status(404).json({ error: "not_found" });
    return true;
  }
  if (err instanceof WalkInIllegalTransitionError) {
    res
      .status(409)
      .json({ error: "invalid_transition", from: err.from, to: err.to });
    return true;
  }
  if (err instanceof WalkInStaleTransitionError) {
    res.status(409).json({ error: "stale_transition" });
    return true;
  }
  if (err instanceof WalkInDuplicateEntryError) {
    res.status(409).json({ error: "duplicate_active_entry" });
    return true;
  }
  if (err instanceof WalkInStaffError) {
    res
      .status(err.message === "staff_not_found" ? 404 : 409)
      .json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * The barber's read: the live queue (claimable WAITING entries plus
 * everyone's positions - the same shop-wide visibility the waitlist board
 * already grants a barber seat) with estimates, and which chair is theirs.
 */
walkInBarberRouter.get("/", async (req, res) => {
  const shop = await loadShop(req.shop!.id);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!shop.walkInEnabled) {
    res.status(409).json({ error: "walk_in_disabled" });
    return;
  }
  const now = new Date();
  const entries = await listQueue(shop.id);
  const estimates = await estimateQueue({
    shopId: shop.id,
    now,
    queue: entries.map((e) => ({
      id: e.id,
      status: e.status,
      position: e.position,
      joinedAt: new Date(e.joinedAt),
      preferredStaffId: e.preferredStaffId,
      assignedStaffId: e.assignedStaffId,
      totalDurationMin: e.totalDurationMin,
      serviceIds: e.services.map((s) => s.serviceId),
    })),
  });
  res.json({
    chairStaffId: req.shopStaffId ?? null,
    acceptingNow: shop.walkInAcceptingNow,
    now: now.toISOString(),
    entries: entries.map((e) => {
      const est = estimates.get(e.id);
      return {
        ...e,
        estimate: {
          projectedStaffId: est?.projectedStaffId ?? null,
          startsAt: est?.startsAt ? est.startsAt.toISOString() : null,
          waitMin: est?.waitMin ?? null,
        },
      };
    }),
  });
});

/** Everything below acts, so everything below needs a chair. */
function chairOf(
  req: Request,
  res: Response,
): Extract<QueueActor, { kind: "barber" }> | null {
  const staffId = req.shopStaffId ?? null;
  if (!staffId) {
    res.status(403).json({ error: "no_chair" });
    return null;
  }
  return { kind: "barber", userId: req.userId ?? null, staffId };
}

walkInBarberRouter.post("/:id/claim", async (req, res) => {
  const shop = await loadShop(req.shop!.id);
  if (!shop || !shop.walkInEnabled) {
    res
      .status(shop ? 409 : 404)
      .json({ error: shop ? "walk_in_disabled" : "not_found" });
    return;
  }
  const actor = chairOf(req, res);
  if (!actor) return;
  try {
    const entry = await claimEntry({
      shopId: shop.id,
      entryId: req.params.id,
      actor,
      now: new Date(),
    });
    res.json({ entry });
  } catch (err) {
    if (!answerError(res, err)) throw err;
  }
});

function transitionRoute(
  path: string,
  run: (opts: {
    shopId: string;
    entryId: string;
    actor: QueueActor;
    now: Date;
  }) => Promise<WalkInEntryView>,
): void {
  walkInBarberRouter.post(`/:id/${path}`, async (req, res) => {
    const shop = await loadShop(req.shop!.id);
    if (!shop || !shop.walkInEnabled) {
      res
        .status(shop ? 409 : 404)
        .json({ error: shop ? "walk_in_disabled" : "not_found" });
      return;
    }
    const actor = chairOf(req, res);
    if (!actor) return;
    try {
      const entry = await run({
        shopId: shop.id,
        entryId: req.params.id,
        actor,
        now: new Date(),
      });
      res.json({ entry });
    } catch (err) {
      if (!answerError(res, err)) throw err;
    }
  });
}

transitionRoute("ready", markReady);
transitionRoute("return", returnToLine);
transitionRoute("no-show", markNoShow);
transitionRoute("leave", markLeft);
