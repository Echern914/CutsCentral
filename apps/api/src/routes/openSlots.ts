import { Router } from "express";
import { requireShop, requireUser } from "../middleware/auth.js";
import { dashboardLimiter } from "../middleware/rateLimit.js";
import { collectOpenSlots } from "../services/openSlotsFacts.js";

/**
 * GET /api/assistant/open-slots - "how many slots do I have open next week?",
 * counted from this shop's own calendar with the booking page's slot engine
 * (services/openSlotsFacts.ts). The Assistant hands it to the support engine
 * as a live fact (packages/config/openSlots.ts).
 *
 * Who sees what - the same rule as /api/assistant/booked-out:
 *   - an owner or manager gets the whole shop;
 *   - a BARBER seat gets their OWN chair only, decided HERE from the seat,
 *     never from anything the browser sends.
 *
 * Counts only: no client names, no money.
 *
 * Not behind the paywall, like the booked-out brief: reads and arithmetic,
 * nothing spent.
 */
export const openSlotsRouter: Router = Router();
openSlotsRouter.use(requireUser, requireShop, dashboardLimiter);

openSlotsRouter.get("/", async (req, res) => {
  const barber = req.shopRole === "BARBER";
  if (barber && !req.shopStaffId) {
    // A provider seat not linked to a calendar has no chair of its own to count.
    res.status(404).json({ error: "no_calendar" });
    return;
  }
  const result = await collectOpenSlots({
    shopId: req.shop!.id,
    ...(barber ? { staffId: req.shopStaffId! } : {}),
  });
  if (!result.ok) {
    // not_native: the open times live in Acuity, Square or the shop's own
    // link, so there is no honest count here. The Assistant falls back to
    // the written answer, which says where to look.
    res.status(404).json({ error: result.reason });
    return;
  }
  res.json({ brief: result.brief });
});
