import type { Router } from "express";
import { z } from "zod";
import { Prisma, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { completeReschedule } from "../engines/acuityMirror.js";
import { pokeAppointmentPass } from "../wallet/appointmentPass.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import {
  checkSeriesEdit,
  planSeriesEdit,
  SeriesConflictError,
  SeriesEditError,
  SeriesStaleError,
  writeSeriesEdit,
  type SeriesEditPlan,
  type SeriesEditRequest,
} from "../engines/seriesEdit.js";

/**
 * "THIS AND FUTURE" ON A REPEAT (engines/seriesEdit.ts has the rules).
 *
 *   POST /series/:id/edit/preview  - what would change, and anything in the way
 *   POST /series/:id/edit          - apply exactly the preview that was shown
 *
 * "This appointment" stays the ordinary single edit (PATCH /appointments/:id).
 * Both sit on the manager-only booking router, like every other edit.
 */

const bodySchema = z
  .object({
    fromAppointmentId: z.string().min(1).max(64),
    changes: z
      .object({
        startMin: z.number().int().min(0).max(24 * 60 - 1).optional(),
        serviceId: z.string().min(1).max(64).optional(),
        staffId: z.string().min(1).max(64).optional(),
      })
      .strict(),
    includeExceptions: z.boolean().optional(),
    customTime: z.boolean().optional(),
  })
  .strict();

const applySchema = bodySchema.extend({ digest: z.string().min(8).max(64) }).strict();

/** Rolls the preview's transaction back: nothing a check touches is kept. */
class PreviewDone extends Error {}

function describePlan(plan: SeriesEditPlan) {
  return {
    digest: plan.digest,
    alreadyDone: plan.alreadyDone,
    change: plan.change.map((v) => ({
      id: v.id,
      from: { startsAt: v.from.startsAt.toISOString(), endsAt: v.from.endsAt.toISOString(), staffId: v.from.staffId, serviceId: v.from.serviceId },
      to: { startsAt: v.to.startsAt.toISOString(), endsAt: v.to.endsAt.toISOString(), staffId: v.to.staffId, serviceId: v.to.serviceId },
      ...(v.problem ? { problem: v.problem } : {}),
    })),
    skipped: plan.skipped.map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), reason: s.reason })),
  };
}

function editError(res: import("express").Response, err: unknown): boolean {
  if (err instanceof SeriesEditError) {
    const status = err.code === "not_found" ? 404 : err.code === "nothing_to_change" ? 400 : 409;
    res.status(status).json({ error: err.code });
    return true;
  }
  return false;
}

export function registerSeriesEdit(router: Router, invalidateAvailability: (shopId: string) => void): void {
  async function request(req: import("express").Request, body: z.infer<typeof bodySchema>): Promise<SeriesEditRequest | null> {
    const shop = await prisma.shop.findUnique({
      where: { id: req.shop!.id },
      select: { id: true, timezone: true, bookingBufferMin: true },
    });
    if (!shop) return null;
    return {
      shopId: shop.id,
      timezone: shop.timezone,
      bufferMin: shop.bookingBufferMin,
      seriesId: req.params.id!,
      fromAppointmentId: body.fromAppointmentId,
      changes: body.changes,
      includeExceptions: body.includeExceptions ?? false,
      customTime: body.customTime ?? false,
      now: new Date(),
    };
  }

  router.post("/series/:id/edit/preview", async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const r = await request(req, parsed.data);
    if (!r) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let plan: SeriesEditPlan | null = null;
    try {
      await runWithShop(r.shopId, async (tx) => {
        plan = await planSeriesEdit(tx, r);
        await checkSeriesEdit(tx, r, plan);
        throw new PreviewDone();
      });
    } catch (err) {
      if (!(err instanceof PreviewDone)) {
        if (editError(res, err)) return;
        logger.error({ err, shopId: r.shopId }, "series edit preview failed");
        res.status(500).json({ error: "preview_failed" });
        return;
      }
    }
    res.json(describePlan(plan!));
  });

  router.post("/series/:id/edit", async (req, res) => {
    const parsed = applySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const r = await request(req, parsed.data);
    if (!r) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let plan: SeriesEditPlan;
    let outbox: Map<string, string[]>;
    try {
      ({ plan, outbox } = await runWithShop(r.shopId, async (tx) => {
        // Lock the repeat's rows from the anchor on: a second apply, or a
        // single edit of one of them, waits here and then sees what this one did.
        await tx.$queryRaw`
          SELECT a.id FROM "Appointment" a
          JOIN "Appointment" anchor ON anchor.id = ${r.fromAppointmentId} AND anchor."shopId" = ${r.shopId}
          WHERE a."seriesId" = ${r.seriesId} AND a."shopId" = ${r.shopId} AND a."startsAt" >= anchor."startsAt"
          FOR UPDATE OF a`;
        const p = await planSeriesEdit(tx, r);
        // A retry of a change that already landed: nothing left to do.
        if (p.change.length === 0) return { plan: p, outbox: new Map<string, string[]>() };
        if (p.digest !== parsed.data.digest) throw new SeriesStaleError();
        if (!(await checkSeriesEdit(tx, r, p))) throw new SeriesConflictError(p);
        return { plan: p, outbox: await writeSeriesEdit(tx, r, p) };
      }));
    } catch (err) {
      if (editError(res, err)) return;
      if (err instanceof SeriesStaleError) {
        res.status(409).json({
          error: "stale_preview",
          reason: "These appointments changed since you reviewed them. Review the change again.",
        });
        return;
      }
      if (err instanceof SeriesConflictError) {
        res.status(409).json({ error: "series_conflict", ...describePlan(err.plan) });
        return;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Two live bookings cannot START at the same minute on one chair. The
        // whole change rolled back.
        res.status(409).json({ error: "slot_taken" });
        return;
      }
      logger.error({ err, shopId: r.shopId }, "series edit failed");
      res.status(500).json({ error: "edit_failed" });
      return;
    }

    if (plan.change.length === 0) {
      res.json({ ok: true, alreadyApplied: plan.alreadyDone > 0, changed: [], skipped: describePlan(plan).skipped });
      return;
    }

    // After commit, one visit at a time: the new block is placed before the old
    // one is released, and each outcome is reported as it is - an Acuity
    // calendar that did not confirm is never shown as moved.
    const changed: { id: string; startsAt: string; endsAt: string; mirror: string }[] = [];
    for (const v of plan.change) {
      const ids = outbox.get(v.id);
      const mirror = ids ? await completeReschedule(r.shopId, v.id, ids) : "skipped";
      void pokeAppointmentPass(v.id);
      changed.push({ id: v.id, startsAt: v.to.startsAt.toISOString(), endsAt: v.to.endsAt.toISOString(), mirror });
    }

    // ONE notice, never one per visit: the next visit that moved, if the client
    // was emailed about it before (the single-edit rule). Every changed visit's
    // own reminder goes out again at its new time, because its send stamps
    // were reset above.
    const next = plan.change.find((v) => v.clientVisible && v.emailedBefore && v.to.startsAt > r.now);
    if (next) void notifyAppointmentConfirmation({ shopId: r.shopId, appointmentId: next.id, moved: true });

    logger.info(
      {
        shopId: r.shopId,
        seriesId: r.seriesId,
        actorUserId: req.userId ?? null,
        changed: changed.length,
        skipped: plan.skipped.length,
        fields: Object.keys(r.changes),
        mirror: changed.map((c) => c.mirror),
      },
      "series edited (this and future)",
    );
    invalidateAvailability(r.shopId);
    res.json({ ok: true, changed, skipped: describePlan(plan).skipped, clientNotified: Boolean(next) });
  });
}
