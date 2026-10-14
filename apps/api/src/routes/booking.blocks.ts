import type { Request, Response, Router } from "express";
import { z } from "zod";
import { MAX_BLOCK_SERVICES } from "@chairback/config/blockScope";
import { appointmentConflictSentence } from "../services/blockOffDays.js";
import {
  createBlocks,
  describeStaffConflicts,
  editBlock,
  MAX_BLOCK_STAFF,
  MAX_REPEAT_WEEKS,
  planBlock,
  readBlock,
  removeBlocks,
  type BlockWhen,
  type CreateBlocksOutcome,
  type EditTiming,
  type StaffConflictRow,
} from "../services/blockOff.js";

/**
 * Block off time: create (one barber or several, a day, a range, one long
 * absence, a bounded weekly repeat), read, edit and remove. Mounted on the
 * dashboard router, so requireManager and the availability-cache hook cover
 * every route here. The write logic lives in services/blockOff.ts.
 */

const reason = z.string().trim().max(200).optional().or(z.literal(""));
/** The digest a previous 409 `appointments_overlap` handed back. */
const confirmation = z.string().trim().min(1).max(200).optional();
const DAY_KEY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
/** Shop-local minutes from midnight; end exclusive, 1440 = end of the day. */
const fromMin = z.number().int().min(0).max(24 * 60 - 1);
const toMin = z.number().int().min(1).max(24 * 60);
/** The form mints one per Save and re-sends it on a retry. */
const requestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, "A request id is 16-64 letters, digits, - or _.")
  .optional();

/**
 * "Selected services": the ids of the services the block stops, at least one.
 * Absent = "All services", the whole chair. An empty list is refused rather
 * than read as either: it is a form that lost its choice.
 */
const serviceIds = z
  .array(z.string().trim().min(1).max(64))
  .min(1, "Pick at least one service, or choose All services.")
  .max(MAX_BLOCK_SERVICES);

const windowFields = { fromMin: fromMin.optional(), toMin: toMin.optional() };
const bothOrNeither = (d: { fromMin?: number; toMin?: number }) =>
  (d.fromMin === undefined) === (d.toMin === undefined);
const BOTH_OR_NEITHER = { message: "Send both fromMin and toMin, or neither for all day." };

const whenSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("day"),
      date: DAY_KEY,
      ...windowFields,
      repeat: z
        .union([
          z.object({ weeks: z.number().int().min(1).max(MAX_REPEAT_WEEKS) }).strict(),
          z.object({ until: DAY_KEY }).strict(),
        ])
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("daily"), fromDate: DAY_KEY, toDate: DAY_KEY, ...windowFields }).strict(),
  z
    .object({
      kind: z.literal("continuous"),
      fromDate: DAY_KEY,
      fromMin,
      toDate: DAY_KEY,
      toMin: z.number().int().min(0).max(24 * 60),
    })
    .strict(),
]);

const createSchema = z
  .object({
    staffIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_BLOCK_STAFF),
    when: whenSchema.refine((w) => w.kind === "continuous" || bothOrNeither(w), BOTH_OR_NEITHER),
    serviceIds: serviceIds.optional(),
    reason,
    requestId,
    confirmation,
  })
  .strict();

function toWhen(w: z.infer<typeof whenSchema>): BlockWhen {
  if (w.kind === "continuous") return w;
  const window =
    w.fromMin !== undefined && w.toMin !== undefined ? { fromMin: w.fromMin, toMin: w.toMin } : undefined;
  if (w.kind === "daily") return { kind: "daily", fromDate: w.fromDate, toDate: w.toDate, window };
  return { kind: "day", date: w.date, window, repeat: w.repeat };
}

function sendConflict(
  res: Response,
  conflicts: StaffConflictRow[],
  digest: string,
  timezone: string,
  manyStaff: boolean,
) {
  // Shown, not just returned: which bookings, when, whose chair, and that
  // they stay put.
  res.status(409).json({
    error: "appointments_overlap",
    confirmable: true,
    reason: appointmentConflictSentence(conflicts),
    conflicts: describeStaffConflicts(conflicts, timezone, manyStaff),
    count: conflicts.length,
    confirmation: digest,
  });
}

function sendCreated(res: Response, req: Request, outcome: CreateBlocksOutcome, manyStaff: boolean) {
  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (outcome.kind === "too_many") {
    res.status(400).json({ error: "invalid_input", issues: [{ path: ["when"], message: outcome.message }] });
    return;
  }
  if (outcome.kind === "bad_services") {
    res
      .status(400)
      .json({ error: "invalid_input", issues: [{ path: ["serviceIds"], message: outcome.message }] });
    return;
  }
  if (outcome.kind === "conflict") {
    sendConflict(res, outcome.conflicts, outcome.confirmation, req.shop!.timezone, manyStaff);
    return;
  }
  // 200 on a replay: nothing new was created, the first try's answer stands.
  res.status(outcome.replayed ? 200 : 201).json({
    ok: true,
    created: outcome.count,
    overlappingAppointments: outcome.overlapping,
    groupId: outcome.groupId,
    ...(outcome.replayed ? { replayed: true } : {}),
  });
}

// ── The old one-barber endpoint, same request shapes as ever ────────────────

// A timed block (or, with isBlock:false, a one-off open window): two instants.
const instantExceptionSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    isBlock: z.boolean().optional(),
    reason,
    confirmation,
  })
  .strict()
  .refine((d) => d.endsAt > d.startsAt, { message: "End must be after start." });
const dayRangeFields = { fromDate: DAY_KEY, toDate: DAY_KEY, reason, confirmation };
const allDayRangeSchema = z.object({ ...dayRangeFields, allDay: z.literal(true) }).strict();
const timedRangeSchema = z
  .object({ ...dayRangeFields, fromMin, toMin })
  .strict();
const exceptionSchema = z.union([instantExceptionSchema, allDayRangeSchema, timedRangeSchema]);

const editSchema = z
  .object({
    scope: z.enum(["one", "group"]),
    reason: z.string().trim().max(200).nullable().optional(),
    timing: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("day"), date: DAY_KEY, ...windowFields }).strict(),
        z.object({ kind: z.literal("window"), ...windowFields }).strict(),
      ])
      .refine(bothOrNeither, BOTH_OR_NEITHER)
      .optional(),
    /** A list = only those services; null = All services; absent = unchanged. */
    serviceIds: serviceIds.nullable().optional(),
    confirmation,
  })
  .strict();

const scopeQuery = z.object({ scope: z.enum(["one", "group"]).default("one") });

export function registerBlockRoutes(router: Router): void {
  /**
   * Block off time on one or more barbers. Every chosen chair's lock is taken
   * (sorted) before anything is read; bookings in the way on ANY of them refuse
   * the whole save with 409 `appointments_overlap` until the barber confirms
   * that exact list. Confirming writes the block and nothing else - no
   * appointment is cancelled, moved or edited here, ever.
   *
   * `requestId` makes a retry safe: the same id answers 200 with the rows the
   * first try wrote, instead of writing them twice.
   */
  router.post("/blocks", async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const timezone = req.shop!.timezone;
    const now = new Date();
    const plan = planBlock(toWhen(d.when), timezone, now);
    if (!plan.ok) {
      res.status(400).json({
        error: "invalid_input",
        issues: [{ path: ["when", plan.field], message: plan.message }],
      });
      return;
    }
    const staffIds = [...new Set(d.staffIds)];
    const outcome = await createBlocks({
      shopId: req.shop!.id,
      timezone,
      staffIds,
      spans: plan.spans,
      pattern: plan.pattern,
      isBlock: true,
      reason: d.reason || null,
      requestId: d.requestId ?? null,
      confirmation: d.confirmation ?? null,
      now,
      serviceIds: d.serviceIds ?? [],
    });
    sendCreated(res, req, outcome, staffIds.length > 1);
  });

  /**
   * Block off time (or open a one-off window) on ONE chair - the original
   * endpoint, kept for every caller that already speaks it. Same write path
   * as POST /blocks; its rows are a group of their own.
   */
  router.post("/staff/:id/exceptions", async (req, res) => {
    const parsed = exceptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const timezone = req.shop!.timezone;
    const now = new Date();
    const when: BlockWhen =
      "fromDate" in d
        ? {
            kind: "daily",
            fromDate: d.fromDate,
            toDate: d.toDate,
            window: "fromMin" in d ? { fromMin: d.fromMin, toMin: d.toMin } : undefined,
          }
        : { kind: "instant", startsAt: d.startsAt, endsAt: d.endsAt };
    const plan = planBlock(when, timezone, now);
    if (!plan.ok) {
      res.status(400).json({
        error: "invalid_input",
        issues: [{ path: [plan.field], message: plan.message }],
      });
      return;
    }
    const outcome = await createBlocks({
      shopId: req.shop!.id,
      timezone,
      staffIds: [req.params.id!],
      spans: plan.spans,
      pattern: plan.pattern,
      isBlock: "isBlock" in d ? (d.isBlock ?? true) : true,
      reason: d.reason || null,
      requestId: null,
      confirmation: d.confirmation ?? null,
      now,
    });
    sendCreated(res, req, outcome, false);
  });

  /** One block as the edit sheet shows it, with its group. */
  router.get("/blocks/:id", async (req, res) => {
    const block = await readBlock({
      shopId: req.shop!.id,
      timezone: req.shop!.timezone,
      id: req.params.id!,
      now: new Date(),
    });
    if (!block) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // The zone rides along: the sheet shows and edits shop-local days and hours.
    res.json({ block, timezone: req.shop!.timezone });
  });

  /**
   * Change a block's note and/or time - this one, or the whole group. A new
   * time re-runs the save's conflict check (409 `appointments_overlap`, same
   * confirmation rule). Appointments are never touched.
   */
  router.patch("/blocks/:id", async (req, res) => {
    const parsed = editSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const timezone = req.shop!.timezone;
    let timing: EditTiming | undefined;
    if (d.timing) {
      const window =
        d.timing.fromMin !== undefined && d.timing.toMin !== undefined
          ? { fromMin: d.timing.fromMin, toMin: d.timing.toMin }
          : undefined;
      timing =
        d.timing.kind === "day" ? { kind: "day", date: d.timing.date, window } : { kind: "window", window };
    }
    const outcome = await editBlock({
      shopId: req.shop!.id,
      timezone,
      id: req.params.id!,
      scope: d.scope,
      reason: d.reason,
      timing,
      serviceIds: d.serviceIds === undefined ? undefined : (d.serviceIds ?? []),
      confirmation: d.confirmation ?? null,
      now: new Date(),
    });
    switch (outcome.kind) {
      case "not_found":
        res.status(404).json({ error: "not_found" });
        return;
      case "bad_services":
        res.status(400).json({
          error: "invalid_input",
          issues: [{ path: ["serviceIds"], message: outcome.message }],
        });
        return;
      case "invalid":
        res.status(400).json({
          error: "invalid_input",
          issues: [{ path: [outcome.field], message: outcome.message }],
        });
        return;
      case "duplicate":
        res.status(409).json({
          error: "already_blocked",
          reason: "Another block from the same save already starts then.",
        });
        return;
      case "conflict":
        sendConflict(res, outcome.conflicts, outcome.confirmation, timezone, outcome.manyStaff);
        return;
      case "updated":
        res.json({ ok: true, updated: outcome.count, overlappingAppointments: outcome.overlapping });
    }
  });

  /**
   * Remove a block (`?scope=one`, the default) or its whole group
   * (`?scope=group`: the rows still to come, plus this one). Blocks only - a
   * one-off open window is never removed here. 404 when nothing was removed:
   * the web layer reads the status, and an already-removed block is that.
   */
  router.delete("/blocks/:id", async (req, res) => {
    const q = scopeQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const { removed } = await removeBlocks({
      shopId: req.shop!.id,
      id: req.params.id!,
      scope: q.data.scope,
      now: new Date(),
    });
    if (removed === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, removed });
  });

  /**
   * The original "Unblock" endpoint: removes exactly this BLOCK. A one-off open
   * window (isBlock:false) is not a block and answers 404 here - removing a
   * block must never quietly take away hours a barber opened.
   */
  router.delete("/exceptions/:id", async (req, res) => {
    const { removed } = await removeBlocks({
      shopId: req.shop!.id,
      id: req.params.id!,
      scope: "one",
      now: new Date(),
    });
    if (removed === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // The freed hours become bookable immediately: the router-level hook
    // invalidates this shop's availability caches on any non-GET that
    // finishes under 400, so the 404 path deliberately skips it.
    res.json({ ok: true });
  });
}
