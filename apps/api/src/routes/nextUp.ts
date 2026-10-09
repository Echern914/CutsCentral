import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma, runWithShop, type Shop } from "@chairback/db";
import { requireShop, requireUser, accessToShop } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { requireRole } from "../auth/roles.js";
import { isWidgetToken, mintWidgetToken, readWidgetToken, WIDGET_TOKEN_TTL_SECONDS } from "../auth/widgetToken.js";
import { resolveNotifyPrefs } from "../services/barberNotify.js";

/**
 * WHO'S NEXT, for the Lock Screen widget.
 *
 * The same appointments the "Next up" push is about, and decided the same way
 * (engines/barberReminders.ts): a booking belongs to the barber linked to its
 * chair, and a chair nobody is linked to belongs to the shop's owner. So the
 * widget and the push never disagree about whose client someone is.
 *
 * Read by the widget with its own narrow token (auth/widgetToken.ts), or by
 * the signed-in app with the session it already has. Either way it says only
 * what a lock screen may show: a first name (or nothing, if the barber turned
 * names off), the service, the time and the chair - no last name, no phone, no
 * notes, no price.
 */

export const nextUpRouter = Router();

/** How far ahead to look: today, tonight, and tomorrow morning's first cut. */
const HORIZON_HOURS = 36;
/** The widget shows the next one or two; a few spare cover a cancelled one. */
const MAX_ROWS = 12;

export interface NextUpAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  /** The client's first name, or null when the barber hides names. */
  client: string | null;
  service: string;
  /** The chair's name - an owner covering unassigned chairs sees which. */
  chair: string;
}

export interface NextUpResponse {
  shop: { name: string; timezone: string };
  showNames: boolean;
  generatedAt: string;
  appointments: NextUpAppointment[];
}

export async function nextUpFor(userId: string, shop: Pick<Shop, "id" | "name" | "timezone" | "ownerId">, now = new Date()): Promise<NextUpResponse> {
  const prefs = await resolveNotifyPrefs(shop.id, userId);
  const horizon = new Date(now.getTime() + HORIZON_HOURS * 3600_000);
  const isOwner = shop.ownerId === userId;
  const rows = await runWithShop(shop.id, (tx) =>
    tx.appointment.findMany({
      where: {
        shopId: shop.id,
        status: "BOOKED",
        // A live payment hold is not a booking yet.
        holdExpiresAt: null,
        endsAt: { gt: now },
        startsAt: { lt: horizon },
        // The Next up recipient rule: his own chair, plus - for the owner -
        // every chair nobody is linked to.
        OR: [{ staff: { userId } }, ...(isOwner ? [{ staff: { userId: null } }] : [])],
      },
      orderBy: { startsAt: "asc" },
      take: MAX_ROWS,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        firstName: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
      },
    }),
  );
  return {
    shop: { name: shop.name, timezone: shop.timezone },
    showNames: prefs.lockScreenNames,
    generatedAt: now.toISOString(),
    appointments: rows.map((a) => ({
      id: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      client: prefs.lockScreenNames ? a.firstName.trim() || null : null,
      service: a.service.name,
      chair: a.staff.name,
    })),
  };
}

/**
 * The widget's own way in. Anything that isn't a widget token falls through
 * to the normal session chain, so the signed-in app can call the same route.
 */
async function widgetAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!isWidgetToken(bearer)) {
    next();
    return;
  }
  const payload = readWidgetToken(bearer, Math.floor(Date.now() / 1000));
  if (!payload) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Signed out (or reset) since it was minted: dead, like every session.
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { tokenVersion: true } });
  if (!user || user.tokenVersion !== payload.v) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Removed from the shop since: nothing to show.
  const access = await accessToShop(payload.userId, payload.shopId);
  if (!access) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!hasActiveAccess(access.shop)) {
    res.status(402).json({ error: "subscription_required" });
    return;
  }
  res.json(await nextUpFor(payload.userId, access.shop));
}

/** GET /api/next-up - the widget token, or the signed-in app's session. */
nextUpRouter.get(
  "/",
  widgetAuth,
  requireUser,
  requireShop,
  requireRole("OWNER", "MANAGER", "BARBER"),
  requireActiveAccess,
  async (req, res) => {
    res.json(await nextUpFor(req.userId!, req.shop!));
  },
);

/**
 * POST /api/next-up/token - the signed-in app asks for a widget token for the
 * shop it is acting in. A demo session can't (requireUser refuses its POSTs).
 */
nextUpRouter.post(
  "/token",
  requireUser,
  requireShop,
  requireRole("OWNER", "MANAGER", "BARBER"),
  requireActiveAccess,
  async (req, res) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = mintWidgetToken({
      userId: req.userId!,
      shopId: req.shop!.id,
      tokenVersion: req.sessionVersion ?? 0,
      nowSeconds,
    });
    res.json({ token, expiresAt: new Date((nowSeconds + WIDGET_TOKEN_TTL_SECONDS) * 1000).toISOString() });
  },
);
