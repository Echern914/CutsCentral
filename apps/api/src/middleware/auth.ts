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
  // app). Try BOTH: a stale cookie must not shadow a valid Authorization header.
  const cookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const authHeader = req.header("Authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;
  const payload = sessionFromToken(cookie) ?? sessionFromToken(bearer);
  if (!payload) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // Revocation check: a token minted before the user's current tokenVersion
  // (e.g. before a password change) is dead even if its signature/expiry hold.
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { tokenVersion: true },
  });
  if (!user || (payload.v ?? 0) !== user.tokenVersion) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  req.userId = payload.userId;
  next();
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
