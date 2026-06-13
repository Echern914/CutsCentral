import type { NextFunction, Request, Response } from "express";
import { hasActiveAccess } from "../billing/stripe.js";

/**
 * 402 gate for the features that cost real money (outbound SMS) once the
 * trial is over and there's no live subscription. Everything else stays open:
 * the dashboard, client book, visit ingest, and punch earning keep working,
 * so the shop's data keeps accruing and coming back is a one-click upgrade,
 * not a cold start. Mount AFTER requireShop.
 */
export function requireActiveAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (hasActiveAccess(req.shop!)) {
    next();
    return;
  }
  res.status(402).json({
    error: "subscription_required",
    message:
      "Texting clients is a Premium feature. Upgrade to send rebooking nudges and promo blasts.",
  });
}
