import type { NextFunction, Request, Response } from "express";
import { ACTIVE_SHOP_COOKIE_NAME } from "@chairback/config";
import { prisma, type Shop } from "@chairback/db";
import { SESSION_COOKIE_NAME, sessionFromToken } from "../auth/session.js";

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
      shop?: Shop;
    }
  }
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
  const versions = new Map<string, number | null>();
  for (const payload of candidates) {
    let version = versions.get(payload.userId);
    if (version === undefined) {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { tokenVersion: true },
      });
      version = user ? user.tokenVersion : null;
      versions.set(payload.userId, version);
    }
    if (version !== null && (payload.v ?? 0) === version) {
      req.userId = payload.userId;
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
  // Honor the active-shop cookie (a manager switching between their own shops),
  // re-verified against ownership inside resolveOwnedShop. Single-shop owners
  // (everyone today) have no cookie and get their one shop unchanged.
  const requestedShopId = req.cookies?.[ACTIVE_SHOP_COOKIE_NAME] as
    | string
    | undefined;
  const shop = await resolveOwnedShop(req.userId, requestedShopId);
  if (!shop) {
    res.status(404).json({ error: "no_shop", message: "Create a shop first." });
    return;
  }
  req.shop = shop;
  next();
}
