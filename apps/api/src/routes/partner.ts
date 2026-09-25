import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../middleware/auth.js";
import { partnerForUser, requestPartnerCashout } from "../services/partnerProgram.js";

/**
 * The partner's own page: their code, referrals, balance, unlock progress, and
 * the cashout request. Needs only a signed-in login - a partner may not run a
 * business on ChairBack at all - and only ever reads the partner row linked to
 * THAT login. Anyone else gets 404.
 */
export const partnerRouter: Router = Router();
partnerRouter.use(requireUser);

partnerRouter.get("/me", async (req, res) => {
  const me = await partnerForUser(req.userId!);
  if (!me) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(me);
});

partnerRouter.post("/me/cashouts", async (req, res) => {
  const parsed = z.object({ amountCents: z.number().int() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_amount" });
    return;
  }
  const result = await requestPartnerCashout(req.userId!, parsed.data.amountCents);
  if (!result.ok) {
    const status = result.error === "not_a_partner" ? 404 : result.error === "invalid_amount" ? 400 : 409;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(201).json({ id: result.cashoutId });
});
