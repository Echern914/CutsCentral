import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasActiveAccess } from "../billing/stripe.js";

/**
 * The wall.
 *
 * ChairBack is one plan. When the trial runs out and there is no live
 * subscription, the shop stops working - it does not fall back to a reduced
 * free tier, because there isn't one any more.
 *
 * 🔑 WHAT STAYS REACHABLE, and why it is a short list rather than nothing:
 * logging in, the billing page, and READING or exporting their own client
 * book. Locking a barber out of their own customer list reads as holding data
 * hostage, invites chargebacks, and wins nothing - they can already export it
 * the day before they lapse. The pressure comes from the shop not FUNCTIONING,
 * not from the data being held.
 *
 * 🔴 This is mounted per-router, on each router's own `requireShop` line, NOT
 * globally in app.ts. It reads `req.shop`, and at the app.ts mount point that
 * is still undefined - these routers resolve the session themselves. See the
 * WALLED list in app.ts for the one place the whole policy is written down.
 *
 * Two escape hatches survive untouched:
 *  - `compAccess` short-circuits inside hasActiveAccess (operator comps).
 *  - `billingEnabled() === false` passes everything, which is how dev and the
 *    whole test suite run.
 */

const WALL_BODY = {
  error: "subscription_required",
  message:
    "Your ChairBack plan has ended. Subscribe to start taking bookings again - your clients and history are all still here.",
} as const;

export function requireActiveAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (hasActiveAccess(req.shop!)) {
    next();
    return;
  }
  res.status(402).json(WALL_BODY);
}

/**
 * The wall, with holes. `isExempt` runs BEFORE the access check, so an exempt
 * path costs nothing when the shop is subscribed and is reachable when it is
 * not.
 *
 * Used for `/api/dashboard`, which is the only router mixing "their own data"
 * (the client book) with the rest of the product. Everywhere else the whole
 * router is one side or the other.
 */
export function requireActiveAccessExcept(
  isExempt: (req: Request) => boolean,
): RequestHandler {
  return (req, res, next) => {
    if (isExempt(req)) {
      next();
      return;
    }
    requireActiveAccess(req, res, next);
  };
}
