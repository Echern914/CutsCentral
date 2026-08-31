import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  AFFILIATE_DECISION_REASONS,
  AFFILIATE_SUSPENSION_REASONS,
  apiEnv,
} from "@chairback/config";
import { correctAttribution } from "../services/affiliateAttribution.js";
import {
  approveApplication,
  getApplicationForAdmin,
  listAccounts,
  listApplications,
  rejectApplication,
  reactivateAccount,
  suspendAccount,
} from "../services/affiliate.js";

/**
 * Affiliate program: the operator's review surface. Sub-mounted under
 * /api/admin-portal/affiliate, so it INHERITS requireUser + requireAdmin (404
 * for every non-admin, shop managers included) from adminPortal.ts's
 * router-level gate, plus requireAdminIp + the dashboard limiter from the
 * app.ts mount. Its own gate below adds the master flag: while the program is
 * dark, even an admin sees 404 - the merge changes nothing visible anywhere.
 *
 * Decision classifications are fixed enums; internalNote is admin-only prose
 * that never reaches an applicant (the public message is derived from the
 * classification in config). Every decision writes its audit event in the
 * same transaction - see services/affiliate.ts.
 */
export const affiliateAdminRouter: Router = Router();

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

affiliateAdminRouter.use(requireAffiliateProgram);

const listQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
});

affiliateAdminRouter.get("/applications", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const applications = await listApplications({ status: parsed.data.status });
  res.json({ applications });
});

affiliateAdminRouter.get("/applications/:id", async (req, res) => {
  const application = await getApplicationForAdmin(req.params.id);
  if (!application) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ application });
});

const approveSchema = z
  .object({ internalNote: z.string().trim().max(2000).optional() })
  .strict();

affiliateAdminRouter.post("/applications/:id/approve", async (req, res) => {
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await approveApplication({
    applicationId: req.params.id,
    adminUserId: req.userId!,
    internalNote: parsed.data.internalNote,
  });
  if (!result.ok) {
    res
      .status(result.error === "not_found" ? 404 : 409)
      .json({ error: result.error });
    return;
  }
  res.json(result.value);
});

const rejectSchema = z
  .object({
    decisionReason: z.enum(AFFILIATE_DECISION_REASONS),
    internalNote: z.string().trim().max(2000).optional(),
  })
  .strict();

affiliateAdminRouter.post("/applications/:id/reject", async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await rejectApplication({
    applicationId: req.params.id,
    adminUserId: req.userId!,
    decisionReason: parsed.data.decisionReason,
    internalNote: parsed.data.internalNote,
  });
  if (!result.ok) {
    res
      .status(result.error === "not_found" ? 404 : 409)
      .json({ error: result.error });
    return;
  }
  res.json(result.value);
});

const accountsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

affiliateAdminRouter.get("/accounts", async (req, res) => {
  const parsed = accountsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const accounts = await listAccounts({ status: parsed.data.status });
  res.json({ accounts });
});

const suspendSchema = z
  .object({
    suspensionReason: z.enum(AFFILIATE_SUSPENSION_REASONS),
    internalNote: z.string().trim().max(2000).optional(),
  })
  .strict();

affiliateAdminRouter.post("/accounts/:id/suspend", async (req, res) => {
  const parsed = suspendSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await suspendAccount({
    accountId: req.params.id,
    adminUserId: req.userId!,
    suspensionReason: parsed.data.suspensionReason,
    internalNote: parsed.data.internalNote,
  });
  if (!result.ok) {
    res
      .status(result.error === "not_found" ? 404 : 409)
      .json({ error: result.error });
    return;
  }
  res.json(result.value);
});

const reactivateSchema = z
  .object({ internalNote: z.string().trim().max(2000).optional() })
  .strict();

affiliateAdminRouter.post("/accounts/:id/reactivate", async (req, res) => {
  const parsed = reactivateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await reactivateAccount({
    accountId: req.params.id,
    adminUserId: req.userId!,
    internalNote: parsed.data.internalNote,
  });
  if (!result.ok) {
    res
      .status(result.error === "not_found" ? 404 : 409)
      .json({ error: result.error });
    return;
  }
  res.json(result.value);
});

/**
 * Move a locked attribution to a different affiliate.
 *
 * The only mutation the lock permits, and the narrowest one: inside the policy
 * window, to an eligible affiliate, with a written reason, recorded as an
 * append-only event naming the previous and the new account. A tenant owner
 * has no route to this at all - it lives behind the operator's own gates.
 */
const correctSchema = z
  .object({
    newCode: z.string().min(1).max(64),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();

affiliateAdminRouter.post("/attributions/:id/correct", async (req, res) => {
  const parsed = correctSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await correctAttribution({
    attributionId: req.params.id,
    newCode: parsed.data.newCode,
    reason: parsed.data.reason,
    adminUserId: req.userId!,
  });
  if (!result.ok) {
    res
      .status(result.error === "not_found" ? 404 : 409)
      .json({ error: result.error });
    return;
  }
  res.json(result.value);
});
