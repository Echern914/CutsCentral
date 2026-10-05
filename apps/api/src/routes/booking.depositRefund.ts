import type { Response, Router } from "express";
import { z } from "zod";
import { MAX_CHARGE_CENTS } from "../billing/payments.js";
import type { DepositRefundOutcome } from "../billing/depositRefund.js";

const depositRefundSchema = z
  .object({
    /**
     * The figure the manager confirmed. Must equal what the booking still
     * holds. Capped at what a booking charge itself may be, so any deposit
     * ChairBack could take can be given back.
     */
    amountCents: z.number().int().positive().max(MAX_CHARGE_CENTS),
    /** The shop's own reason, for its records. Never sent to the client. */
    note: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * POST /api/booking/appointments/:id/deposit-refund — give back what a
 * cancelled or no-show booking kept from its booking payment.
 *
 * Owners and managers only, like the rest of this router (requireManager). Not
 * under /api/checkout on purpose: that router is the post-service checkout's
 * kill switch and canary allowlist, and a deposit is taken at BOOKING by every
 * deposit-mode shop, canary or not. The refund rule itself, and why the shop's
 * own Stripe dashboard cannot do this correctly, is billing/depositRefund.ts.
 *
 * Every answer says what actually happened to the money, as the checkout
 * refund's do: done; it was already done; the figure moved; ChairBack support
 * has to finish it; Stripe said no; or we could not tell and pressing again is
 * safe.
 */
export function registerDepositRefund(router: Router): void {
  router.post("/appointments/:id/deposit-refund", async (req, res) => {
    const parsed = depositRefundSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const { refundKeptDeposit } = await import("../billing/depositRefund.js");
    const result = await refundKeptDeposit({
      shopId: req.shop!.id,
      appointmentId: req.params.id!,
      confirmedCents: parsed.data.amountCents,
      actorUserId: req.userId ?? null,
      note: parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null,
    });
    sendRefundOutcome(res, result);
  });
}

/**
 * POST /api/booking/appointments/:id/tip-refund - give back a tip the client
 * left online after the visit. Owners and managers only (this router's
 * requireManager), the same body and the same answers as the deposit refund:
 * the same refund engine does both (billing/depositRefund.ts), with the tip's
 * own key, source tag and fee rule - Stripe's fee stays with the shop.
 */
export function registerTipRefund(router: Router): void {
  router.post("/appointments/:id/tip-refund", async (req, res) => {
    const parsed = depositRefundSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const { refundTip } = await import("../billing/depositRefund.js");
    const result = await refundTip({
      shopId: req.shop!.id,
      appointmentId: req.params.id!,
      confirmedCents: parsed.data.amountCents,
      actorUserId: req.userId ?? null,
      note: parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null,
    });
    sendRefundOutcome(res, result);
  });
}

function sendRefundOutcome(
  res: Response,
  result: DepositRefundOutcome,
): void {
  switch (result.outcome) {
    case "refunded":
      res.json({ ok: true, result: "refunded", amountCents: result.amountCents, status: result.status });
      return;
    case "already_refunded":
      res.json({ ok: true, result: "already_refunded", amountCents: result.refundedCents });
      return;
    // Not found rather than forbidden for another shop's id, like every read here.
    case "not_found":
      res.status(404).json({ error: "not_found" });
      return;
    case "nothing_to_refund":
      res.status(409).json({ error: "nothing_to_refund" });
      return;
    case "amount_changed":
      res.status(409).json({ error: "amount_changed", refundableCents: result.refundableCents });
      return;
    case "not_refundable":
      res.status(409).json({ error: "not_refundable", reason: result.reason });
      return;
    case "needs_support":
      res.status(409).json({ error: "needs_support", reason: result.reason });
      return;
    case "refused":
      res.status(402).json({ error: "refund_refused", code: result.code });
      return;
    case "unconfirmed":
      // Accepted, not failed: the refund may exist. Pressing again names the
      // same idempotency key, so it cannot become a second refund.
      res.status(202).json({ ok: false, result: "unconfirmed" });
      return;
    case "stripe_unavailable":
      res.status(503).json({ error: "stripe_unavailable" });
      return;
  }
}
