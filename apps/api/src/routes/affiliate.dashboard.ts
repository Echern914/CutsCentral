import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  AFFILIATE_PROMOTION_CHANNELS,
  AFFILIATE_TERMS_VERSION,
  apiEnv,
} from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireOwner } from "../auth/roles.js";
import { affiliateApplyLimiter } from "../middleware/rateLimit.js";
import { getAffiliateStatus, submitApplication } from "../services/affiliate.js";

/**
 * The Affiliate Program's OWNER surface: apply, and read your own standing.
 *
 * This is the NEW program - not the legacy referral page at
 * /api/dashboard/referrals, which keeps running untouched until the
 * attribution phase freezes it.
 *
 * Gates, in order:
 *   1. AFFILIATE_PROGRAM_ENABLED (env, default false): while off this whole
 *      surface answers 404 as if it does not exist - the schema and API can
 *      merge and sit dark in production. Checked BEFORE auth on purpose, so
 *      a dark surface is indistinguishable from an unmounted one.
 *   2. requireOwner: only the shop's actual owner may apply or accept terms.
 *      Managers and barbers get the honest 403 the role gate always answers.
 *   3. AFFILIATE_PUBLIC_APPLICATIONS_ENABLED gates ONLY the application door:
 *      status stays readable with the master flag alone, because turning the
 *      door off must not blind an existing affiliate to their own standing.
 *
 * Deliberately NOT behind requireActiveAccess: a lapsed shop must still see
 * its affiliate status, and nothing here moves money.
 */
export const affiliateDashboardRouter: Router = Router();

/** Dark-launch gate. 404 (not 403): while the platform flag is off the
 * surface should be indistinguishable from a route that was never mounted. */
function requireAffiliateProgram(
  _req: Request,
  res: Response,
  next: () => void,
): void {
  if (!apiEnv().AFFILIATE_PROGRAM_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

/** The application DOOR, separately switchable from the program itself. */
function requirePublicApplications(
  _req: Request,
  res: Response,
  next: () => void,
): void {
  if (!apiEnv().AFFILIATE_PUBLIC_APPLICATIONS_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

affiliateDashboardRouter.use(
  requireAffiliateProgram,
  requireUser,
  requireShop,
  requireOwner,
);

affiliateDashboardRouter.get("/status", async (req, res) => {
  const status = await getAffiliateStatus(req.shop!.id);
  res.json(status);
});

const applicationSchema = z
  .object({
    // The applicant re-states the version they read; a stale page (terms
    // bumped since it loaded) is refused rather than silently re-versioned.
    termsVersion: z.string(),
    termsAccepted: z.literal(true),
    ftcAccepted: z.literal(true),
    promotionChannels: z
      .array(z.enum(AFFILIATE_PROMOTION_CHANNELS))
      .min(1)
      .max(AFFILIATE_PROMOTION_CHANNELS.length),
    audienceDescription: z.string().trim().min(1).max(1000),
    links: z
      .array(z.string().trim().url().max(300).startsWith("http"))
      .max(5)
      .default([]),
    promotionPlan: z.string().trim().min(1).max(2000),
  })
  .strict();

affiliateDashboardRouter.post(
  "/application",
  requirePublicApplications,
  affiliateApplyLimiter,
  async (req, res) => {
    const parsed = applicationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    if (parsed.data.termsVersion !== AFFILIATE_TERMS_VERSION) {
      res.status(400).json({ error: "terms_not_accepted" });
      return;
    }
    const result = await submitApplication({
      shopId: req.shop!.id,
      userId: req.userId!,
      promotionChannels: [...new Set(parsed.data.promotionChannels)],
      audienceDescription: parsed.data.audienceDescription,
      links: parsed.data.links,
      promotionPlan: parsed.data.promotionPlan,
    });
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.status(201).json({ application: result.application });
  },
);
