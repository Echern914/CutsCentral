import type { Router } from "express";
import { z } from "zod";
import { Prisma, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { completeReschedule, readMirrorOutcomes } from "../engines/acuityMirror.js";
import { trackBackgroundWork } from "../backgroundWork.js";
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
 *   GET  /series/:id/edit/mirror   - where applied dates stand with Acuity now
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
      bookedPriceCents: v.bookedPriceCents,
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
    const arrived = Date.now();
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

    // After commit, Acuity is told one date at a time: each new block is placed
    // before its old one is released (completeReschedule). That runs ON ITS
    // OWN and the answer does not wait for all of it - see ANSWER_WITHIN_MS.
    // Each date is then reported as the outbox has it at answer time: a date
    // Acuity has not confirmed yet is "unknown" (still confirming), never moved.
    const moves = plan.change.filter((v) => outbox.has(v.id));
    const syncing = trackBackgroundWork(placeMovesOnAcuity(r.shopId, moves.map((v) => [v.id, outbox.get(v.id)!])));
    await settledOrDeadline(syncing, arrived + answerWithinMs);
    const mirrors = await readMirrorOutcomes(
      r.shopId,
      moves.map((v) => v.id),
    );
    const changed: { id: string; startsAt: string; endsAt: string; mirror: string }[] = [];
    for (const v of plan.change) {
      void pokeAppointmentPass(v.id);
      changed.push({
        id: v.id,
        startsAt: v.to.startsAt.toISOString(),
        endsAt: v.to.endsAt.toISOString(),
        mirror: outbox.has(v.id) ? (mirrors.get(v.id) ?? "unknown") : "skipped",
      });
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

  // Where the dates of an applied change stand with Acuity NOW - for a result
  // that went out while some were still confirming. A read of the outbox the
  // reconciler settles; nothing is sent to Acuity from here.
  router.get("/series/:id/edit/mirror", async (req, res) => {
    const parsed = mirrorQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const shopId = req.shop!.id;
    const ids = [...new Set(parsed.data.ids.split(","))];
    const rows = await prisma.appointment.findMany({
      where: { shopId, seriesId: req.params.id!, id: { in: ids } },
      select: { id: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: "asc" },
    });
    const mirrors = await readMirrorOutcomes(
      shopId,
      rows.map((a) => a.id),
    );
    res.json({
      changed: rows.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        mirror: mirrors.get(a.id) ?? "unknown",
      })),
    });
  });
}

const mirrorQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .max(64 * 64)
    .refine((s) => {
      const parts = s.split(",");
      return parts.length <= 64 && parts.every((p) => p.length >= 1 && p.length <= 64);
    }),
});

/**
 * 🔴 HOW LONG AFTER IT ARRIVED THE APPLY ANSWERS, whatever Acuity is doing.
 *
 * The dashboard gives up on a request after 12 s (apps/web lib/api.ts) and then
 * can only say "we couldn't confirm that went through" - losing the per-date
 * result, the one place a date Acuity refused is named. Telling Acuity about a
 * long repeat one date at a time can take longer than that on its own, so the
 * answer goes out by this point with every date as the outbox has it: confirmed,
 * refused, or still confirming. Counted from arrival, so a slow transaction
 * eats into Acuity's share rather than pushing the answer past the deadline.
 *
 * NOT a timeout on Acuity: nothing is abandoned. The dates carry on after the
 * answer (placeMovesOnAcuity), and if this process dies first their PENDING /
 * UNKNOWN / RELEASING rows are the five-minute reconciler's, exactly as for
 * any other booking. GET /series/:id/edit/mirror reads where they got to.
 */
const ANSWER_WITHIN_MS = 7_000;
let answerWithinMs = ANSWER_WITHIN_MS;

/** Tests only: answer sooner, so a slow fake Acuity does not cost seconds. */
export function __setSeriesEditAnswerWithinForTests(ms: number | undefined): void {
  answerWithinMs = ms ?? ANSWER_WITHIN_MS;
}

/**
 * Place each moved date on Acuity, in order, after commit. Never throws: a date
 * whose step errors is left in the outbox, where the reconciler finishes it.
 */
async function placeMovesOnAcuity(shopId: string, moves: [appointmentId: string, outboxIds: string[]][]): Promise<void> {
  for (const [appointmentId, outboxIds] of moves) {
    try {
      await completeReschedule(shopId, appointmentId, outboxIds);
    } catch (err) {
      logger.error({ err, shopId, appointmentId }, "series edit: acuity step failed - reconciler owns it");
    }
  }
}

/** Resolve when `work` settles or at `deadline` (epoch ms), whichever is first. */
async function settledOrDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    }),
  ]);
  if (timer) clearTimeout(timer);
}
