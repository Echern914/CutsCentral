import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { apiEnv } from "@chairback/config";
import { backfillShop } from "../acuity/backfill.js";
import { promoteCompletedVisits } from "../engines/statusPromotion.js";
import { runNudgeSweep } from "../engines/nudge.js";
import { linkBookingsToNudges } from "../engines/attribution.js";
import { expireDeadWaitlistEntries } from "../engines/waitlistExpiry.js";
import { expireStaleWalkIns } from "../engines/walkInExpiry.js";

const env = apiEnv();
export const adminRouter: Router = Router();

/** Constant-time string compare (hash both sides so length never leaks). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Bearer token guard for platform-operator endpoints. */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.ADMIN_TOKEN || !safeEqual(token, env.ADMIN_TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

adminRouter.use(requireAdmin);

adminRouter.post("/backfill/:shopId", async (req, res) => {
  const result = await backfillShop(req.params.shopId);
  res.json(result);
});

adminRouter.post("/promote", async (_req, res) => {
  const promoted = await promoteCompletedVisits();
  res.json({ promoted });
});

adminRouter.post("/nudge-sweep", async (req, res) => {
  const dryRun = req.query.dryRun !== "false"; // default dry-run unless explicitly false
  const summaries = await runNudgeSweep({ dryRun });
  res.json({ summaries });
});

adminRouter.post("/attribution", async (_req, res) => {
  const linked = await linkBookingsToNudges();
  res.json({ linked });
});

/**
 * Waitlist phase F2: how many entries WOULD the expiry sweep retire?
 *
 * Read-only by construction, not by parameter. The sweep already has exactly
 * one preview mode - the same one the hourly job runs in while
 * WAITLIST_ENTRY_EXPIRY_ENABLED is false - so this route adds no rule, no
 * query and no second opinion. It calls the engine and shapes the answer.
 *
 * 🔴 { dryRun: true } IS HARD-CODED AND UNREACHABLE FROM THE REQUEST. There is
 *    no write mode to ask for: no body is read, no query is read, and anything
 *    sent is REFUSED rather than ignored - so `?dryRun=false` or
 *    `{"write":true}` gets a 400, not a silent no-op that reads like success.
 *    (POST/nudge-sweep above takes ?dryRun for historical reasons; this one
 *    deliberately does not follow it.)
 *
 * 🔴 NOTHING CUSTOMER-LEVEL COMES BACK. Shop id, name and slug identify a
 *    shop; everything else is a count. No entry ids, names, contact details,
 *    preference windows or tokens - the same rule the audit metadata follows.
 *
 * Independent of ENABLE_SCHEDULER (it is a request, not a cron) and of the
 * feature flag (dryRun is passed explicitly, so the flag's value cannot make
 * this write).
 */
/**
 * Walk-in expiry sweep preview: the same scan the hourly job runs, forced
 * dry. Counts only - never a customer. Same no-parameters contract as the
 * waitlist preview above it.
 */
adminRouter.post("/walk-in-expiry-preview", async (req, res) => {
  const extras = [
    ...Object.keys((req.body ?? {}) as Record<string, unknown>),
    ...Object.keys(req.query ?? {}),
  ];
  if (extras.length > 0) {
    res.status(400).json({
      error: "no_parameters_accepted",
      detail: "Preview-only; there is no write mode to request.",
      rejected: extras.slice(0, 10),
    });
    return;
  }
  const evaluatedAt = new Date();
  const r = await expireStaleWalkIns(evaluatedAt, { dryRun: true });
  res.json({
    evaluatedAt: evaluatedAt.toISOString(),
    dryRun: true,
    scanned: r.scanned,
    wouldExpire: r.actionable,
    evaluationErrors: r.errors,
    partial: r.budgetExhausted,
    shops: r.byShop,
  });
});

adminRouter.post("/waitlist-expiry-preview", async (req, res) => {
  // Refuse, never ignore. An operator who typed dryRun:false must be told it
  // meant nothing, not handed a 200 that looks like it was honored.
  const extras = [
    ...Object.keys((req.body ?? {}) as Record<string, unknown>),
    ...Object.keys(req.query ?? {}),
  ];
  if (extras.length > 0) {
    res.status(400).json({
      error: "no_parameters_accepted",
      detail:
        "This endpoint is preview-only and takes no body or query parameters. " +
        "There is no write mode to request.",
      rejected: extras.slice(0, 10),
    });
    return;
  }

  const evaluatedAt = new Date();
  const r = await expireDeadWaitlistEntries(evaluatedAt, { dryRun: true });

  res.json({
    evaluatedAt: evaluatedAt.toISOString(),
    dryRun: true,
    scanned: r.scanned,
    wouldExpire: r.actionable,
    heldBackByLiveOffer: r.heldBack,
    legacySkipped: r.legacySkipped,
    zeroWindowSkipped: r.zeroWindowSkipped,
    evaluationErrors: r.errors,
    // True only if the scan hit its time budget - the numbers are then a
    // floor, not a total, and saying so beats a quiet undercount.
    partial: r.budgetExhausted,
    shops: r.byShop.map((s) => ({
      shopId: s.shopId,
      name: s.name,
      slug: s.slug,
      scanned: s.scanned,
      wouldExpire: s.actionable,
      heldBackByLiveOffer: s.heldBack,
      legacySkipped: s.legacySkipped,
      zeroWindowSkipped: s.zeroWindowSkipped,
      evaluationErrors: s.errors,
    })),
  });
});
