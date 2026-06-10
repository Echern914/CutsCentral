import type { NextFunction, Request, Response } from "express";
import { prisma, type Shop } from "@chairback/db";
import { SESSION_COOKIE_NAME, sessionFromToken } from "../auth/session.js";

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
  const shop = await prisma.shop.findFirst({ where: { ownerId: req.userId } });
  if (!shop) {
    res.status(404).json({ error: "no_shop", message: "Create a shop first." });
    return;
  }
  req.shop = shop;
  next();
}
