import type { NextFunction, Request, Response } from "express";
import { prisma } from "@chairback/db";

/**
 * Platform-admin gate for the operator portal. Runs AFTER requireUser, and
 * derives admin status from the DB by the session's userId - NEVER from
 * anything the client sends. A normal customer session can never satisfy this:
 * isAdmin is a column set only by hand / the bootstrap script, with no
 * self-serve path to flip it. 404 (not 403) so the portal's existence isn't
 * even confirmed to non-admins.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.userId) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { isAdmin: true },
  });
  if (!user?.isAdmin) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}
