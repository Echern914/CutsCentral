import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { verifyWebHandoff } from "../auth/webHandoff.js";
import { setSessionCookie } from "../auth/session.js";
import { accessToShop } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

/**
 * The far side of the iOS app's "Manage plan on getchairback.com".
 *
 * The app mints a one-time code (POST /api/billing/handoff) and opens Safari;
 * the web's /auth/billing/landing exchanges it HERE, server-to-server, for a
 * session token and sets it on its own origin - the Google/Apple landing shape
 * (auth/webHandoff.ts). The long-lived token never appears in a URL.
 *
 * The shop comes back too, so a barber on a team lands in the shop the app
 * was showing rather than their own. It is re-checked against ownership or a
 * seat here, and the API re-checks it on every request anyway.
 */
export const BILLING_HANDOFF_PURPOSE = "billing-handoff";

export const authBillingHandoffRouter: Router = Router();

const exchangeSchema = z.object({ code: z.string().min(1).max(1000) }).strict();

authBillingHandoffRouter.post("/billing/exchange", authLimiter, async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const handoff = verifyWebHandoff(
    parsed.data.code,
    BILLING_HANDOFF_PURPOSE,
    Math.floor(Date.now() / 1000),
  );
  if (!handoff) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: handoff.userId } });
  if (!user) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }
  const access = handoff.shopId ? await accessToShop(user.id, handoff.shopId) : null;
  const token = setSessionCookie(res, user.id, user.tokenVersion);
  res.json({ token, shopId: access ? access.shop.id : null });
});
