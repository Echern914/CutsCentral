import type { NextFunction, Request, Response } from "express";

/**
 * Role gate for shop members.
 *
 * Until team seats existed, every authenticated principal WAS the shop owner,
 * so no route needed a permission check. Now an employee can sign in, and the
 * safe default is that they can do NOTHING until a route is deliberately
 * opened to them: `requireRole` is applied at the ROUTER level (see
 * booking.dashboard.ts and friends) rather than per route, so a route added
 * later inherits the restriction instead of silently being wide open.
 *
 * OWNER is always allowed everywhere an OWNER-listed gate appears; it is the
 * only role that can touch billing, integrations, or the team itself.
 */
export type ShopRole = "OWNER" | "MANAGER" | "BARBER";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in user's role in req.shop. Set by requireShop. */
      shopRole?: ShopRole;
      /** The Staff row this member works, when their seat is linked to one. */
      shopStaffId?: string | null;
    }
  }
}

/**
 * Allow only the listed roles. Answers 403 `forbidden_role` (never 404) so the
 * UI can tell "you can't do this" apart from "this doesn't exist", and includes
 * the required roles for a useful message.
 */
export function requireRole(...allowed: ShopRole[]) {
  return function roleGate(req: Request, res: Response, next: NextFunction): void {
    const role = req.shopRole;
    if (!role) {
      // requireShop must have run first. Failing closed here means a
      // mis-ordered router can't accidentally grant access.
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    if (!allowed.includes(role)) {
      res.status(403).json({
        error: "forbidden_role",
        message: "Your role doesn't have access to this.",
        required: allowed,
      });
      return;
    }
    next();
  };
}

/** Owner-only: billing, integrations, team management, shop deletion. */
export const requireOwner = requireRole("OWNER");

/** Everything that runs the shop day to day, but not ownership concerns. */
export const requireManager = requireRole("OWNER", "MANAGER");
