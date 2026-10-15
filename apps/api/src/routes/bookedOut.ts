import { Router } from "express";
import { requireShop, requireUser } from "../middleware/auth.js";
import { dashboardLimiter } from "../middleware/rateLimit.js";
import { diagnoseBookedOut } from "../engines/bookedOut.js";
import { collectBookedOutFacts } from "../services/bookedOutFacts.js";

/**
 * GET /api/assistant/booked-out - "how do I get booked out more?", answered
 * from this shop's own numbers. The Assistant fetches it server-side and hands
 * it to the support engine as a live fact (packages/config/bookedOut.ts).
 *
 * Who sees what, the readiness rule:
 *   - an owner or manager gets the whole shop;
 *   - a BARBER seat gets their OWN book only - their appointments, their
 *     hours, their clients - and never another provider's numbers or the
 *     shop's page settings, which are not theirs to change.
 *
 * Counts and percentages only: no money and no client names leave here.
 *
 * NOT behind the paywall, like /api/readiness: the Assistant works on every
 * plan, and a shop that is struggling to fill its book is the one that needs
 * this. Nothing here spends anything - it is reads and arithmetic.
 */
export const bookedOutRouter: Router = Router();
bookedOutRouter.use(requireUser, requireShop, dashboardLimiter);

bookedOutRouter.get("/", async (req, res) => {
  const shopId = req.shop!.id;
  const barber = req.shopRole === "BARBER";
  if (barber && !req.shopStaffId) {
    // A provider seat not linked to a calendar has no book of its own to read.
    res.status(404).json({ error: "no_calendar" });
    return;
  }
  const facts = await collectBookedOutFacts({
    shopId,
    ...(barber ? { staffId: req.shopStaffId! } : {}),
  });
  if (!facts) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ brief: diagnoseBookedOut(facts) });
});
