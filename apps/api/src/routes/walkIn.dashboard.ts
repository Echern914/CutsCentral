import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import {
  assignEntry,
  cancelEntry,
  createEntryByStaff,
  editEntry,
  listFinished,
  listQueue,
  markLeft,
  markNoShow,
  markReady,
  reorderEntry,
  returnToLine,
  WalkInDuplicateEntryError,
  WalkInIllegalTransitionError,
  WalkInNotFoundError,
  WalkInQueueFullError,
  WalkInServiceSelectionError,
  WalkInStaffError,
  WalkInStaleTransitionError,
  type QueueActor,
  type WalkInEntryView,
} from "../engines/walkInQueue.js";
import { estimateQueue } from "../engines/walkInEstimate.js";
import { shopLocalDayWindow } from "../engines/serviceDailyLimit.js";

/**
 * Walk-In Mode: the MANAGER surface (the Live Queue board's API). Its own
 * router file on purpose - the open Square stack edits booking.dashboard.ts,
 * and a queue is not booking config.
 *
 * Two gates in front of everything:
 *   1. WALK_IN_MODE_ENABLED (env, default false): while off, this whole
 *      surface answers 404 as if it does not exist - the feature can merge
 *      and sit dark in production.
 *   2. Shop.walkInEnabled (default false): an authed manager whose shop has
 *      not turned the feature on gets an honest 409 walk_in_disabled (they
 *      are allowed to know it exists; their shop just has it off).
 *
 * The BARBER surface is routes/walkIn.barber.ts; a barber seat never reaches
 * this router (requireManager), same as the rest of /api/booking.
 */
export const walkInDashboardRouter: Router = Router();

/** Dark-launch gate. 404 (not 403): while the platform flag is off the
 * surface should be indistinguishable from a route that was never mounted. */
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

walkInDashboardRouter.use(
  requireWalkInMode,
  requireUser,
  requireShop,
  requireManager,
  requireActiveAccess,
);

/** Shop config for every handler: timezone for day math, the two toggles.
 * Read as the OWNER (Shop is RLS-denied inside runWithShop). */
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

function actorOf(req: Request): Extract<QueueActor, { kind: "manager" }> {
  return {
    kind: "manager",
    userId: req.userId ?? null,
    staffId: req.shopStaffId ?? null,
  };
}

/** One place to turn engine errors into route answers. */
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
  if (err instanceof WalkInQueueFullError) {
    res.status(409).json({ error: "queue_full" });
    return true;
  }
  if (err instanceof WalkInDuplicateEntryError) {
    res.status(409).json({ error: "duplicate_active_entry" });
    return true;
  }
  if (err instanceof WalkInServiceSelectionError) {
    res.status(400).json({ error: err.message });
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

/** Attach the deterministic estimates to a queue read. */
async function withEstimates(
  shopId: string,
  entries: WalkInEntryView[],
  now: Date,
): Promise<
  Array<
    WalkInEntryView & {
      estimate: {
        projectedStaffId: string | null;
        startsAt: string | null;
        waitMin: number | null;
      };
    }
  >
> {
  const estimates = await estimateQueue({
    shopId,
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
  return entries.map((e) => {
    const est = estimates.get(e.id);
    return {
      ...e,
      estimate: {
        projectedStaffId: est?.projectedStaffId ?? null,
        startsAt: est?.startsAt ? est.startsAt.toISOString() : null,
        waitMin: est?.waitMin ?? null,
      },
    };
  });
}

/**
 * The board. Live entries in queue order with estimates; ?includeDone=1 adds
 * everything that went terminal today (the "done" section).
 */
walkInDashboardRouter.get("/queue", async (req, res) => {
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
  const withEst = await withEstimates(shop.id, entries, now);
  const includeDone = req.query.includeDone === "1";
  const done = includeDone
    ? await listFinished(shop.id, shopLocalDayWindow(now, shop.timezone).start)
    : [];
  res.json({
    acceptingNow: shop.walkInAcceptingNow,
    now: now.toISOString(),
    entries: withEst,
    ...(includeDone ? { done } : {}),
  });
});

const createSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(40).optional(),
    serviceIds: z.array(z.string().min(1)).min(1).max(3),
    preferredStaffId: z.string().min(1).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/** Staff-side add ("walk-in at the counter, put them in the line"). */
walkInDashboardRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shop = await loadShop(req.shop!.id);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!shop.walkInEnabled) {
    res.status(409).json({ error: "walk_in_disabled" });
    return;
  }
  try {
    const entry = await createEntryByStaff({
      shopId: shop.id,
      timezone: shop.timezone,
      actor: actorOf(req),
      input: parsed.data,
      now: new Date(),
    });
    res.status(201).json({ entry });
  } catch (err) {
    if (!answerError(res, err)) throw err;
  }
});

const editSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().max(80).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    preferredStaffId: z.string().min(1).nullable().optional(),
    serviceIds: z.array(z.string().min(1)).min(1).max(3).optional(),
  })
  .strict();

walkInDashboardRouter.patch("/:id", async (req, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shop = await loadShop(req.shop!.id);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!shop.walkInEnabled) {
    res.status(409).json({ error: "walk_in_disabled" });
    return;
  }
  try {
    const entry = await editEntry({
      shopId: shop.id,
      timezone: shop.timezone,
      entryId: req.params.id,
      actor: actorOf(req),
      now: new Date(),
      patch: parsed.data,
    });
    res.json({ entry });
  } catch (err) {
    if (!answerError(res, err)) throw err;
  }
});

const assignSchema = z.object({ staffId: z.string().min(1) }).strict();

walkInDashboardRouter.post("/:id/assign", async (req, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shop = await loadShop(req.shop!.id);
  if (!shop || !shop.walkInEnabled) {
    res
      .status(shop ? 409 : 404)
      .json({ error: shop ? "walk_in_disabled" : "not_found" });
    return;
  }
  try {
    const entry = await assignEntry({
      shopId: shop.id,
      entryId: req.params.id,
      staffId: parsed.data.staffId,
      actor: actorOf(req),
      now: new Date(),
    });
    res.json({ entry });
  } catch (err) {
    if (!answerError(res, err)) throw err;
  }
});

/** The shared shape of every simple transition endpoint below. */
function transitionRoute(
  path: string,
  run: (opts: {
    shopId: string;
    entryId: string;
    actor: QueueActor;
    now: Date;
  }) => Promise<WalkInEntryView>,
): void {
  walkInDashboardRouter.post(`/:id/${path}`, async (req, res) => {
    const shop = await loadShop(req.shop!.id);
    if (!shop || !shop.walkInEnabled) {
      res
        .status(shop ? 409 : 404)
        .json({ error: shop ? "walk_in_disabled" : "not_found" });
      return;
    }
    try {
      const entry = await run({
        shopId: shop.id,
        entryId: req.params.id,
        actor: actorOf(req),
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
transitionRoute("leave", markLeft);
transitionRoute("no-show", markNoShow);
transitionRoute("cancel", cancelEntry);
// POST /:id/start is deliberately NOT here yet: starting service creates a
// real Appointment through the overlap guard and lands in PR 3.

const reorderSchema = z
  .object({
    afterEntryId: z.string().min(1).nullable(),
    expectedPosition: z.number().int(),
  })
  .strict();

walkInDashboardRouter.post("/:id/reorder", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shop = await loadShop(req.shop!.id);
  if (!shop || !shop.walkInEnabled) {
    res
      .status(shop ? 409 : 404)
      .json({ error: shop ? "walk_in_disabled" : "not_found" });
    return;
  }
  try {
    const entry = await reorderEntry({
      shopId: shop.id,
      entryId: req.params.id,
      afterEntryId: parsed.data.afterEntryId,
      expectedPosition: parsed.data.expectedPosition,
      actor: actorOf(req),
      now: new Date(),
    });
    res.json({ entry });
  } catch (err) {
    if (!answerError(res, err)) throw err;
  }
});
