import { Router } from "express";
import { DEMO } from "@chairback/config";
import { prisma } from "@chairback/db";
import { setDemoSessionCookie } from "../auth/session.js";
import { authLimiter } from "../middleware/rateLimit.js";

export const demoRouter: Router = Router();

/**
 * Mint a READ-ONLY dashboard session for the demo tenant so a prospect can
 * explore the barber side without an account. Public by design: the demo shop
 * holds no real data, the `demo` session claim makes requireUser reject every
 * mutating request (and all /oauth/ paths), and the token is short-lived.
 * Refuses when the demo tenant isn't seeded (envs without one) or when the
 * `demo` slug somehow belongs to a real owner — same paranoia as the seeder.
 */
demoRouter.post("/session", authLimiter, async (req, res) => {
  const shop = await prisma.shop.findFirst({
    where: { slug: DEMO.SHOP_SLUG },
    select: { owner: { select: { id: true, email: true, tokenVersion: true } } },
  });
  if (!shop || shop.owner.email !== DEMO.OWNER_EMAIL) {
    res.status(404).json({ error: "demo_unavailable" });
    return;
  }
  setDemoSessionCookie(res, shop.owner.id, shop.owner.tokenVersion);
  res.json({ ok: true });
});
