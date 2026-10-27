import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { dismissNotice, noticesForUser } from "../services/platformNotices.js";

/**
 * Platform notices: the barber's side. Any signed-in person on the dashboard
 * (owner, manager or staff seat) reads what is live and closes a banner for
 * themselves. NEVER WALLED and needs no shop: "we know about the problem" is
 * exactly what a lapsed or half-set-up shop must still be able to read.
 * Writes live in adminPortal.notices.ts, behind the admin gates.
 */
export const platformNoticesRouter: Router = Router();
platformNoticesRouter.use(requireUser);

platformNoticesRouter.get("/", async (req, res) => {
  const notices = await noticesForUser(req.userId!);
  // Private (per person: dismissals differ) and briefly cacheable - the
  // dashboard asks on every page load.
  res.setHeader("Cache-Control", "private, max-age=10");
  res.json({ notices });
});

platformNoticesRouter.post("/:id/dismiss", async (req, res) => {
  const ok = await dismissNotice(req.userId!, req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
