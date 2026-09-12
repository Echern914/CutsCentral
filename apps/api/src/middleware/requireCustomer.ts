import type { NextFunction, Request, Response } from "express";
import { apiEnv } from "@chairback/config";
import { runAsOwner } from "@chairback/db";
import { customerSessionFromToken } from "../auth/customerSession.js";

/**
 * The My ChairBack door.
 *
 * `requireCustomerAccounts` is the platform switch: while
 * CUSTOMER_ACCOUNTS_ENABLED is off, every customer-account route answers 404
 * exactly as an unknown path does, so the surface can merge and sit dark.
 *
 * `requireCustomer` resolves a Bearer customer session to req.customer. The
 * account id comes from the SIGNED session and nowhere else - no route under
 * it ever accepts an account id from a path, body or query. A token minted
 * before the account's current tokenVersion (deleted, or signed out
 * everywhere) is dead, and so is a token for an account that no longer exists.
 *
 * A demo session is read-only by METHOD, the same wall the demo dashboard
 * uses: anything but GET/HEAD is refused.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: { accountId: string; demo: boolean };
    }
  }
}

export function requireCustomerAccounts(_req: Request, res: Response, next: NextFunction): void {
  if (!apiEnv().CUSTOMER_ACCOUNTS_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

export async function requireCustomer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const session = customerSessionFromToken(token);
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const account = await runAsOwner((tx) =>
    tx.customerAccount.findUnique({
      where: { id: session.accountId },
      select: { id: true, tokenVersion: true, isDemo: true },
    }),
  );
  // A demo claim must name a demo account and a real claim a real one: a token
  // can never talk its way across that line in either direction.
  if (!account || account.tokenVersion !== session.version || account.isDemo !== session.demo) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (account.isDemo && req.method !== "GET" && req.method !== "HEAD") {
    res.status(403).json({
      error: "demo_read_only",
      message: "This is a demo. Sign in with your own number to make changes.",
    });
    return;
  }
  req.customer = { accountId: account.id, demo: account.isDemo };
  next();
}
