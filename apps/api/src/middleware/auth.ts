import type { NextFunction, Request, Response } from "express";
import { prisma, type Shop } from "@chairback/db";
import { SESSION_COOKIE_NAME, userIdFromCookie } from "../auth/session.js";

/**
 * Auth middleware. requireUser resolves the session → req.userId. requireShop
 * additionally loads the barber's owned shop → req.shop. THE RULE: dashboard/API
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

export function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const cookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const userId = userIdFromCookie(cookie);
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.userId = userId;
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
