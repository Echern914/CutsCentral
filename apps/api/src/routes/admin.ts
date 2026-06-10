import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { apiEnv } from "@chairback/config";
import { backfillShop } from "../acuity/backfill.js";
import { promoteCompletedVisits } from "../engines/statusPromotion.js";
import { runNudgeSweep } from "../engines/nudge.js";
import { linkBookingsToNudges } from "../engines/attribution.js";

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
