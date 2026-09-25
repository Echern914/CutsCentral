import { Router } from "express";
import { z } from "zod";
import {
  createPartner,
  markPartnerCashoutPaid,
  partnersForAdmin,
  setPartnerActive,
} from "../services/partnerProgram.js";

/**
 * Partner program: the operator's side. Sub-mounted under
 * /api/admin-portal/partners, so it INHERITS requireUser + requireAdmin (a
 * non-admin gets the portal's existence-hiding 404) from adminPortal.ts, plus
 * requireAdminIp and the dashboard limiter from the app.ts mount.
 *
 * Nothing here moves money. "Mark paid" records that an admin already paid a
 * cashout by hand.
 */
export const partnerAdminRouter: Router = Router();

partnerAdminRouter.get("/", async (_req, res) => {
  res.json(await partnersForAdmin());
});

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    code: z.string().trim().min(1).max(64),
    // The ChairBack login that will see the earnings page. Optional.
    email: z.string().trim().max(254).optional(),
  })
  .strict();

partnerAdminRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const result = await createPartner({
    name: parsed.data.name,
    code: parsed.data.code,
    email: parsed.data.email || null,
    adminUserId: req.userId!,
  });
  if (!result.ok) {
    res.status(result.error === "code_taken" || result.error === "user_taken" ? 409 : 400).json({
      error: result.error,
    });
    return;
  }
  res.status(201).json({ id: result.partnerId });
});

partnerAdminRouter.post("/:id/active", async (req, res) => {
  const parsed = z.object({ active: z.boolean() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const found = await setPartnerActive(req.params.id, parsed.data.active);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ active: parsed.data.active });
});

partnerAdminRouter.post("/cashouts/:id/paid", async (req, res) => {
  const result = await markPartnerCashoutPaid(req.params.id, req.userId!);
  if (result === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (result === "already_paid") {
    res.status(409).json({ error: "already_paid" });
    return;
  }
  res.json({ status: "PAID" });
});
