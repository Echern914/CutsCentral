import type { NextFunction, Request, Response } from "express";
import { ACTIVE_SHOP_COOKIE_NAME } from "@chairback/config";
import { prisma, type Shop } from "@chairback/db";
import { SESSION_COOKIE_NAME, sessionFromToken } from "../auth/session.js";
import { effectiveSeatRole, type ShopRole } from "../auth/roles.js";

/**
 * Resolve which of an owner's shops is "active". A manager who owns several
 * shops names one via the ACTIVE_SHOP_COOKIE_NAME cookie (set on the web origin,
 * forwarded to the API). SECURITY: the cookie is only ever a HINT - we re-verify
 * ownership here (id AND ownerId), so a forged/stale cookie naming someone
 * else's shop resolves to null and we fall back to this owner's OWN first shop.
 * Tenant access is therefore still derived solely from the session, never from a
 * client-supplied id. Fallback order is deterministic (oldest shop first).
 */
export async function resolveOwnedShop(
  userId: string,
  requestedShopId?: string,
): Promise<Shop | null> {
  if (requestedShopId) {
    const picked = await prisma.shop.findFirst({
      where: { id: requestedShopId, ownerId: userId },
    });
    if (picked) return picked;
  }
  return prisma.shop.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: "asc" },
  });
}

export interface ShopAccess {
  shop: Shop;
  role: ShopRole;
  staffId: string | null;
}

/**
 * Can this user act in THIS shop, and as what? Null when they can't.
 *
 * OWNERSHIP FIRST - `Shop.ownerId` is the source of truth, so an owner's access
 * never depends on a ShopMember row existing or being correct. Only then a seat.
 */
export async function accessToShop(
  userId: string,
  shopId: string,
): Promise<ShopAccess | null> {
  const owned = await prisma.shop.findFirst({ where: { id: shopId, ownerId: userId } });
  if (owned) return { shop: owned, role: "OWNER", staffId: null };
  const seat = await prisma.shopMember.findFirst({
    where: { userId, shopId },
    include: { shop: true },
  });
  if (!seat) return null;
  return {
    shop: seat.shop,
    role: effectiveSeatRole(seat.role, seat.shop.ownerId === userId),
    staffId: seat.staffId,
  };
}

/**
 * Resolve which shop this session acts in, and with what role.
 *
 * `hints` are the shops the person asked for, most specific first: this
 * device's active-shop cookie, then the choice remembered on the account. Each
 * is only ever a HINT, re-verified against ownership OR a seat by accessToShop,
 * so a forged or stale id naming someone else's shop grants nothing and falls
 * through to the next.
 *
 * 🔴 A HINT NAMING A TEAM SEAT MUST BE HONORED EVEN FOR SOMEONE WHO OWNS A
 * SHOP. It used to be checked against ownership alone, and an unmatched hint
 * fell straight back to the person's own shop - so an independent barber who
 * joined another shop's team could never act in it: every request, and the
 * switcher itself, landed them back in their own business.
 *
 * With no usable hint: the person's own oldest shop, then their oldest seat.
 * A seat is still never consulted while ownership answers, which is what keeps
 * adding team seats safe for every shop that already exists.
 */
export async function resolveShopAccess(
  userId: string,
  ...hints: Array<string | null | undefined>
): Promise<ShopAccess | null> {
  const tried = new Set<string>();
  for (const hint of hints) {
    if (!hint || tried.has(hint)) continue;
    tried.add(hint);
    const access = await accessToShop(userId, hint);
    if (access) return access;
  }

  const owned = await resolveOwnedShop(userId);
  if (owned) return { shop: owned, role: "OWNER", staffId: null };

  const seat = await prisma.shopMember.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { shop: true },
  });
  if (!seat) return null;
  return {
    shop: seat.shop,
    role: effectiveSeatRole(seat.role, seat.shop.ownerId === userId),
    staffId: seat.staffId,
  };
}

/**
 * Auth middleware. requireUser resolves the session to req.userId. requireShop
 * additionally loads the barber's owned shop to req.shop. THE RULE: dashboard/API
 * routes derive shopId ONLY from the session here, never from params/body.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /**
       * The shop this account last chose to work in (User.activeShopId), read
       * by requireUser in the same query as the revocation check. A HINT for
       * resolveShopAccess, never a grant.
       */
      rememberedShopId?: string | null;
      shop?: Shop;
      /** True when the session carries the read-only demo claim. */
      demoSession?: boolean;
    }
  }
}

/**
 * The read-only wall for public demo-dashboard sessions. One choke point:
 * every authenticated route runs through requireUser, so blocking mutating
 * METHODS here makes the whole dashboard read-only for a demo session without
 * touching individual routes. OAuth starts/callbacks are GETs with side
 * effects (they could CONNECT a real Acuity/Square account to the demo shop),
 * so those paths are refused outright.
 */
function demoSessionAllowed(req: Request): boolean {
  if (req.originalUrl.includes("/oauth/")) return false;
  return req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Accept either the httpOnly session cookie (web) or a bearer token (native
  // app). Try BOTH all the way through the revocation check: a stale or even
  // REVOKED cookie must not shadow a valid Authorization header.
  const cookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const authHeader = req.header("Authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;
  const candidates = [sessionFromToken(cookie), sessionFromToken(bearer)].filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );

  // Revocation check: a token minted before the user's current tokenVersion
  // (e.g. before a password change or logout) is dead even if its
  // signature/expiry hold. Cache per userId - both candidates usually agree.
  const users = new Map<string, { tokenVersion: number; activeShopId: string | null } | null>();
  for (const payload of candidates) {
    let user = users.get(payload.userId);
    if (user === undefined) {
      user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { tokenVersion: true, activeShopId: true },
      });
      users.set(payload.userId, user);
    }
    if (user !== null && (payload.v ?? 0) === user.tokenVersion) {
      if (payload.demo === true) {
        if (!demoSessionAllowed(req)) {
          res.status(403).json({
            error: "demo_read_only",
            message: "This is a read-only demo. Create your own shop to make changes.",
          });
          return;
        }
        req.demoSession = true;
      }
      req.userId = payload.userId;
      req.rememberedShopId = user.activeShopId;
      next();
      return;
    }
  }
  res.status(401).json({ error: "unauthorized" });
}

export async function requireShop(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // requireUser must run first.
  if (!req.userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // This device's switcher choice first, then the one remembered on the
  // account (the app's WebView, a new laptop). Both re-verified inside
  // resolveShopAccess. Someone with one shop and no team has neither and gets
  // their one shop, unchanged.
  const access = await resolveShopAccess(
    req.userId,
    req.cookies?.[ACTIVE_SHOP_COOKIE_NAME] as string | undefined,
    req.rememberedShopId,
  );
  if (!access) {
    res.status(404).json({ error: "no_shop", message: "Create a shop first." });
    return;
  }
  req.shop = access.shop;
  req.shopRole = access.role;
  req.shopStaffId = access.staffId;
  next();
}
