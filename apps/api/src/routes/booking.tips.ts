import type { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { bookingWriteLimiter, rewardsLimiter } from "../middleware/rateLimit.js";
import { createTipIntent, refreshTipFromStripe } from "../billing/tips.js";
import { liveTipWhere, TIP_SHOP_SELECT, tipClosedReason, tipViewFor } from "../services/tips.js";

/**
 * A TIP FROM THE CLIENT'S OWN APPOINTMENT PAGE (/book/manage/<token>).
 *
 * The manage token is the page's authentication, exactly as it is for cancel
 * and reschedule: it lets someone PAY a tip with a card they enter, never
 * charge a card on file (a saved card needs proof of possession - a later
 * change, billing/savedCard.ts).
 *
 *   POST /api/book/manage/:token/tip  { amountCents }  -> a client secret
 *   GET  /api/book/manage/:token/tip                   -> where the tip stands
 *
 * Both answer from the one eligibility check (services/tips.ts) the page uses
 * to decide whether to show the tip card at all.
 */

const tipSchema = z.object({ amountCents: z.number().int() }).strict();

async function loadForTip(manageToken: string) {
  const appt = await prisma.appointment.findUnique({
    where: { manageToken },
    select: {
      id: true,
      shopId: true,
      status: true,
      endsAt: true,
      clientId: true,
      groupId: true,
      priceAtBooking: true,
      visit: { select: { acuityAppointmentId: true } },
      service: { select: { name: true } },
    },
  });
  if (!appt) return null;
  // Shop has RLS with no policy, so it is read directly, as /manage reads it.
  const [shop, tip] = await Promise.all([
    prisma.shop.findUnique({ where: { id: appt.shopId }, select: TIP_SHOP_SELECT }),
    prisma.payment.findFirst({
      where: { appointmentId: appt.id, ...liveTipWhere() },
      select: { status: true, amount: true, capturedAmount: true, refundedAmount: true },
    }),
  ]);
  return shop ? { appt, shop, tip } : null;
}

export function registerTipRoutes(router: Router): void {
  router.post("/manage/:token/tip", bookingWriteLimiter, async (req, res) => {
    const parsed = tipSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const loaded = await loadForTip(String(req.params.token));
    if (!loaded) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { appt, shop } = loaded;
    const closed = tipClosedReason(appt, shop, new Date());
    if (closed) {
      res.status(409).json({ error: "tip_closed", reason: closed });
      return;
    }
    const result = await createTipIntent({
      shopId: appt.shopId,
      appointmentId: appt.id,
      connectAccountId: shop.stripeConnectAccountId!,
      amountCents: parsed.data.amountCents,
      description: `${appt.service?.name ?? "Visit"} - tip`,
    });
    switch (result.outcome) {
      case "ready":
        res.json({ clientSecret: result.clientSecret, amountCents: result.amountCents });
        return;
      case "invalid_amount":
        res.status(400).json({ error: "invalid_amount" });
        return;
      case "already_tipped":
        res.status(409).json({ error: "already_tipped" });
        return;
      case "in_progress":
        res.status(409).json({ error: "tip_in_progress" });
        return;
      case "refused":
        res.status(402).json({ error: "tip_refused", code: result.code });
        return;
      case "unconfirmed":
        // The intent may exist. Trying again names the same request, so it
        // cannot become a second one.
        res.status(202).json({ ok: false, result: "unconfirmed" });
        return;
      case "unavailable":
        res.status(503).json({ error: "payments_unavailable" });
        return;
    }
  });

  router.get("/manage/:token/tip", rewardsLimiter, async (req, res) => {
    const token = String(req.params.token);
    const first = await loadForTip(token);
    if (!first) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Ask Stripe, so "thank you" never waits on the webhook. Best effort.
    await refreshTipFromStripe(first.appt.id);
    const loaded = (await loadForTip(token)) ?? first;
    res.json({ tip: tipViewFor(loaded.appt, loaded.shop, loaded.tip, new Date()) });
  });
}
