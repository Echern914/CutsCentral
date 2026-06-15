import type { NextFunction, Request, Response } from "express";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Optional IP allowlist for the whole operator surface (/admin token routes +
 * /api/admin-portal session routes). A second, network-level lock on top of the
 * isAdmin/ADMIN_TOKEN gates: even with valid credentials, a request from an
 * un-listed IP gets the same existence-hiding 404 a non-admin gets.
 *
 * FAIL-OPEN by design: when ADMIN_IP_ALLOWLIST is empty the check is skipped
 * entirely, so a blank/typo'd value can never lock the operator out - they just
 * fall back to credential-only protection. Set the env var to opt in; blank it
 * to recover. (req.ip is the real client IP because app.set("trust proxy", 1).)
 */

/**
 * Normalize an IP for comparison. Express/Node report an IPv4 client behind an
 * IPv6 socket as an IPv4-mapped address ("::ffff:1.2.3.4"); strip that prefix so
 * a plain "1.2.3.4" in the allowlist matches. Lowercased for IPv6 hex.
 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/** Parse the comma-separated env var into a normalized set (once, at module load). */
function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => normalizeIp(s))
      .filter((s) => s.length > 0),
  );
}

const allowlist = parseAllowlist(apiEnv().ADMIN_IP_ALLOWLIST);

export function requireAdminIp(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Fail-open: no allowlist configured => credential gates are the only control.
  if (allowlist.size === 0) {
    next();
    return;
  }
  const clientIp = normalizeIp(req.ip ?? "");
  if (clientIp && allowlist.has(clientIp)) {
    next();
    return;
  }
  // Existence-hiding 404 (same shape as the non-admin response), and log the
  // blocked IP so the operator can add it to the allowlist if it's their own.
  logger.warn({ blockedIp: clientIp, path: req.path }, "admin IP not allowlisted");
  res.status(404).json({ error: "not_found" });
}
